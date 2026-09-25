BEGIN;

CREATE TABLE inventory.fifo_cost_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  source_stock_ledger_id uuid NOT NULL REFERENCES inventory.stock_ledger(id) ON DELETE RESTRICT,
  received_at timestamptz NOT NULL,
  original_quantity numeric(38,8) NOT NULL CHECK (original_quantity>0),
  remaining_quantity numeric(38,8) NOT NULL CHECK (remaining_quantity>=0),
  unit_cost_base numeric(38,8) NOT NULL CHECK (unit_cost_base>=0),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,product_id)
    REFERENCES inventory.products(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,warehouse_id)
    REFERENCES inventory.warehouses(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE inventory.fifo_cost_layer_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  layer_id uuid NOT NULL,
  issue_stock_ledger_id uuid NOT NULL REFERENCES inventory.stock_ledger(id) ON DELETE RESTRICT,
  quantity numeric(38,8) NOT NULL CHECK (quantity>0),
  unit_cost_base numeric(38,8) NOT NULL CHECK (unit_cost_base>=0),
  total_cost_base numeric(38,8) NOT NULL CHECK (total_cost_base>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,layer_id)
    REFERENCES inventory.fifo_cost_layers(organization_id,id) ON DELETE RESTRICT
);

CREATE INDEX fifo_layers_open_idx
ON inventory.fifo_cost_layers(
  organization_id,product_id,warehouse_id,received_at,id
)
WHERE remaining_quantity>0;

ALTER TABLE inventory.fifo_cost_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.fifo_cost_layer_consumptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY fifo_layers_tenant ON inventory.fifo_cost_layers
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE POLICY fifo_consumptions_tenant ON inventory.fifo_cost_layer_consumptions
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE OR REPLACE FUNCTION inventory.post_document(p_document_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_doc inventory.inventory_documents%ROWTYPE;
  v_currency varchar(3);
  v_journal uuid;
  v_journal_line integer := 0;
  v_line record;
  v_product record;
  v_warehouse uuid;
  v_unit_cost_base numeric(38,8);
  v_total_cost_base numeric(38,8);
  v_remaining numeric(38,8);
  v_take numeric(38,8);
  v_layer record;
  v_issue_ledger uuid;
  v_in_ledger uuid;
  v_qty_on_hand numeric(38,8);
  v_inventory_value numeric(38,8);
  v_average_cost numeric(38,8);
  v_contra_account uuid;
  v_is_incoming boolean;
  v_is_outgoing boolean;
  v_is_transfer boolean;
BEGIN
  PERFORM app.assert_permission('inventory.post',v_org);

  SELECT *
  INTO v_doc
  FROM inventory.inventory_documents
  WHERE organization_id=v_org AND id=p_document_id
  FOR UPDATE;

  IF NOT FOUND OR v_doc.status<>'draft' THEN
    RAISE EXCEPTION 'DRAFT_INVENTORY_DOCUMENT_NOT_FOUND';
  END IF;

  v_is_transfer := v_doc.document_type='transfer';
  v_is_incoming := v_doc.document_type IN (
    'receipt','adjustment_in','purchase_receipt','sales_return','production_receipt'
  );
  v_is_outgoing := v_doc.document_type IN (
    'issue','adjustment_out','purchase_return','sale_issue','production_issue'
  );

  IF NOT (v_is_transfer OR v_is_incoming OR v_is_outgoing) THEN
    RAISE EXCEPTION 'UNSUPPORTED_INVENTORY_DOCUMENT_TYPE';
  END IF;

  IF v_is_transfer AND (
    v_doc.from_warehouse_id IS NULL
    OR v_doc.to_warehouse_id IS NULL
    OR v_doc.from_warehouse_id=v_doc.to_warehouse_id
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSFER_WAREHOUSES';
  END IF;

  IF v_is_incoming AND v_doc.to_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'DESTINATION_WAREHOUSE_REQUIRED';
  END IF;

  IF v_is_outgoing AND v_doc.from_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'SOURCE_WAREHOUSE_REQUIRED';
  END IF;

  IF NOT v_is_transfer THEN
    PERFORM app.assert_permission('accounting.journals.post',v_org);
    SELECT base_currency_code INTO v_currency
    FROM app.organizations WHERE id=v_org;

    INSERT INTO accounting.journal_entries(
      organization_id,entry_date,document_date,source,reference_type,reference_id,
      description,currency_code,exchange_rate
    ) VALUES(
      v_org,v_doc.document_date,v_doc.document_date,'inventory',
      'inventory_document',v_doc.id::text,
      'Inventory document '||v_doc.document_number,v_currency,1
    )
    RETURNING id INTO v_journal;
  END IF;

  FOR v_line IN
    SELECT *
    FROM inventory.inventory_document_lines
    WHERE organization_id=v_org AND document_id=v_doc.id
    ORDER BY line_number
  LOOP
    SELECT
      p.product_type,
      p.costing_method,
      p.inventory_asset_account_id,
      p.cogs_account_id
    INTO v_product
    FROM inventory.products p
    WHERE p.organization_id=v_org
      AND p.id=v_line.product_id
      AND p.is_active;

    IF NOT FOUND OR v_product.product_type<>'stocked' THEN
      RAISE EXCEPTION 'INVALID_STOCKED_PRODUCT';
    END IF;

    IF v_product.inventory_asset_account_id IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_INVENTORY_ACCOUNT_REQUIRED';
    END IF;

    IF v_is_transfer THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(v_org::text||':'||v_line.product_id::text||':'||v_doc.from_warehouse_id::text,0)
      );

      SELECT COALESCE(quantity_on_hand,0),COALESCE(inventory_value,0)
      INTO v_qty_on_hand,v_inventory_value
      FROM inventory.stock_on_hand
      WHERE organization_id=v_org
        AND product_id=v_line.product_id
        AND warehouse_id=v_doc.from_warehouse_id;

      IF COALESCE(v_qty_on_hand,0)<v_line.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK';
      END IF;

      IF v_product.costing_method='fifo' THEN
        v_remaining := v_line.quantity;

        FOR v_layer IN
          SELECT *
          FROM inventory.fifo_cost_layers
          WHERE organization_id=v_org
            AND product_id=v_line.product_id
            AND warehouse_id=v_doc.from_warehouse_id
            AND remaining_quantity>0
          ORDER BY received_at,id
          FOR UPDATE
        LOOP
          EXIT WHEN v_remaining<=0;
          v_take := least(v_remaining,v_layer.remaining_quantity);
          v_total_cost_base := round(v_take*v_layer.unit_cost_base,8);

          INSERT INTO inventory.stock_ledger(
            organization_id,inventory_document_id,inventory_document_line_id,
            product_id,warehouse_id,direction,quantity,unit_cost_base,total_cost_base
          ) VALUES(
            v_org,v_doc.id,v_line.id,v_line.product_id,v_doc.from_warehouse_id,
            'out',v_take,v_layer.unit_cost_base,v_total_cost_base
          ) RETURNING id INTO v_issue_ledger;

          UPDATE inventory.fifo_cost_layers
          SET remaining_quantity=remaining_quantity-v_take
          WHERE organization_id=v_org AND id=v_layer.id;

          INSERT INTO inventory.fifo_cost_layer_consumptions(
            organization_id,layer_id,issue_stock_ledger_id,quantity,unit_cost_base,total_cost_base
          ) VALUES(
            v_org,v_layer.id,v_issue_ledger,v_take,v_layer.unit_cost_base,v_total_cost_base
          );

          INSERT INTO inventory.stock_ledger(
            organization_id,inventory_document_id,inventory_document_line_id,
            product_id,warehouse_id,direction,quantity,unit_cost_base,total_cost_base
          ) VALUES(
            v_org,v_doc.id,v_line.id,v_line.product_id,v_doc.to_warehouse_id,
            'in',v_take,v_layer.unit_cost_base,v_total_cost_base
          ) RETURNING id INTO v_in_ledger;

          INSERT INTO inventory.fifo_cost_layers(
            organization_id,product_id,warehouse_id,source_stock_ledger_id,
            received_at,original_quantity,remaining_quantity,unit_cost_base
          ) VALUES(
            v_org,v_line.product_id,v_doc.to_warehouse_id,v_in_ledger,
            clock_timestamp(),v_take,v_take,v_layer.unit_cost_base
          );

          v_remaining := v_remaining-v_take;
        END LOOP;

        IF v_remaining>0 THEN
          RAISE EXCEPTION 'FIFO_COST_LAYERS_INSUFFICIENT';
        END IF;
      ELSE
        IF v_qty_on_hand<=0 THEN RAISE EXCEPTION 'MOVING_AVERAGE_STOCK_EMPTY'; END IF;
        v_average_cost := round(v_inventory_value/v_qty_on_hand,8);
        v_total_cost_base := round(v_line.quantity*v_average_cost,8);

        INSERT INTO inventory.stock_ledger(
          organization_id,inventory_document_id,inventory_document_line_id,
          product_id,warehouse_id,direction,quantity,unit_cost_base,total_cost_base
        ) VALUES(
          v_org,v_doc.id,v_line.id,v_line.product_id,v_doc.from_warehouse_id,
          'out',v_line.quantity,v_average_cost,v_total_cost_base
        );

        INSERT INTO inventory.stock_ledger(
          organization_id,inventory_document_id,inventory_document_line_id,
          product_id,warehouse_id,direction,quantity,unit_cost_base,total_cost_base
        ) VALUES(
          v_org,v_doc.id,v_line.id,v_line.product_id,v_doc.to_warehouse_id,
          'in',v_line.quantity,v_average_cost,v_total_cost_base
        );
      END IF;

      CONTINUE;
    END IF;

    IF v_is_incoming THEN
      IF v_line.unit_cost IS NULL OR v_line.unit_cost<0 THEN
        RAISE EXCEPTION 'INCOMING_UNIT_COST_REQUIRED';
      END IF;

      v_warehouse := v_doc.to_warehouse_id;
      v_unit_cost_base := round(v_line.unit_cost*v_doc.exchange_rate,8);
      v_total_cost_base := round(v_line.quantity*v_unit_cost_base,8);

      INSERT INTO inventory.stock_ledger(
        organization_id,inventory_document_id,inventory_document_line_id,
        product_id,warehouse_id,direction,quantity,unit_cost_base,total_cost_base
      ) VALUES(
        v_org,v_doc.id,v_line.id,v_line.product_id,v_warehouse,
        'in',v_line.quantity,v_unit_cost_base,v_total_cost_base
      ) RETURNING id INTO v_in_ledger;

      IF v_product.costing_method='fifo' THEN
        INSERT INTO inventory.fifo_cost_layers(
          organization_id,product_id,warehouse_id,source_stock_ledger_id,
          received_at,original_quantity,remaining_quantity,unit_cost_base
        ) VALUES(
          v_org,v_line.product_id,v_warehouse,v_in_ledger,clock_timestamp(),
          v_line.quantity,v_line.quantity,v_unit_cost_base
        );
      END IF;

      v_contra_account := CASE
        WHEN v_doc.document_type='sales_return' THEN v_product.cogs_account_id
        ELSE v_doc.offset_account_id
      END;

      IF v_contra_account IS NULL THEN RAISE EXCEPTION 'INVENTORY_CONTRA_ACCOUNT_REQUIRED'; END IF;

      v_journal_line := v_journal_line+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_journal_line,v_product.inventory_asset_account_id,
        COALESCE(v_line.description,'Inventory receipt'),
        v_total_cost_base,0,v_currency,1,v_total_cost_base,0,v_line.id::text
      );

      v_journal_line := v_journal_line+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_journal_line,v_contra_account,
        COALESCE(v_line.description,'Inventory receipt offset'),
        0,v_total_cost_base,v_currency,1,0,v_total_cost_base,v_line.id::text
      );

      CONTINUE;
    END IF;

    v_warehouse := v_doc.from_warehouse_id;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_org::text||':'||v_line.product_id::text||':'||v_warehouse::text,0)
    );

    SELECT COALESCE(quantity_on_hand,0),COALESCE(inventory_value,0)
    INTO v_qty_on_hand,v_inventory_value
    FROM inventory.stock_on_hand
    WHERE organization_id=v_org
      AND product_id=v_line.product_id
      AND warehouse_id=v_warehouse;

    IF COALESCE(v_qty_on_hand,0)<v_line.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK';
    END IF;

    v_total_cost_base := 0;

    IF v_product.costing_method='fifo' THEN
      v_remaining := v_line.quantity;

      FOR v_layer IN
        SELECT *
        FROM inventory.fifo_cost_layers
        WHERE organization_id=v_org
          AND product_id=v_line.product_id
          AND warehouse_id=v_warehouse
          AND remaining_quantity>0
        ORDER BY received_at,id
        FOR UPDATE
      LOOP
        EXIT WHEN v_remaining<=0;
        v_take := least(v_remaining,v_layer.remaining_quantity);

        INSERT INTO inventory.stock_ledger(
          organization_id,inventory_document_id,inventory_document_line_id,
          product_id,warehouse_id,direction,quantity,unit_cost_base,total_cost_base
        ) VALUES(
          v_org,v_doc.id,v_line.id,v_line.product_id,v_warehouse,
          'out',v_take,v_layer.unit_cost_base,round(v_take*v_layer.unit_cost_base,8)
        ) RETURNING id INTO v_issue_ledger;

        INSERT INTO inventory.fifo_cost_layer_consumptions(
          organization_id,layer_id,issue_stock_ledger_id,quantity,unit_cost_base,total_cost_base
        ) VALUES(
          v_org,v_layer.id,v_issue_ledger,v_take,v_layer.unit_cost_base,
          round(v_take*v_layer.unit_cost_base,8)
        );

        UPDATE inventory.fifo_cost_layers
        SET remaining_quantity=remaining_quantity-v_take
        WHERE organization_id=v_org AND id=v_layer.id;

        v_total_cost_base := v_total_cost_base+round(v_take*v_layer.unit_cost_base,8);
        v_remaining := v_remaining-v_take;
      END LOOP;

      IF v_remaining>0 THEN RAISE EXCEPTION 'FIFO_COST_LAYERS_INSUFFICIENT'; END IF;
    ELSE
      IF v_qty_on_hand<=0 THEN RAISE EXCEPTION 'MOVING_AVERAGE_STOCK_EMPTY'; END IF;
      v_average_cost := round(v_inventory_value/v_qty_on_hand,8);
      v_total_cost_base := round(v_line.quantity*v_average_cost,8);

      INSERT INTO inventory.stock_ledger(
        organization_id,inventory_document_id,inventory_document_line_id,
        product_id,warehouse_id,direction,quantity,unit_cost_base,total_cost_base
      ) VALUES(
        v_org,v_doc.id,v_line.id,v_line.product_id,v_warehouse,
        'out',v_line.quantity,v_average_cost,v_total_cost_base
      );
    END IF;

    v_contra_account := CASE
      WHEN v_doc.document_type='sale_issue' THEN v_product.cogs_account_id
      ELSE v_doc.offset_account_id
    END;

    IF v_contra_account IS NULL THEN RAISE EXCEPTION 'INVENTORY_CONTRA_ACCOUNT_REQUIRED'; END IF;

    v_journal_line := v_journal_line+1;
    INSERT INTO accounting.journal_lines(
      organization_id,journal_entry_id,line_number,account_id,description,
      debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
    ) VALUES(
      v_org,v_journal,v_journal_line,v_contra_account,
      COALESCE(v_line.description,'Inventory issue offset'),
      v_total_cost_base,0,v_currency,1,v_total_cost_base,0,v_line.id::text
    );

    v_journal_line := v_journal_line+1;
    INSERT INTO accounting.journal_lines(
      organization_id,journal_entry_id,line_number,account_id,description,
      debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
    ) VALUES(
      v_org,v_journal,v_journal_line,v_product.inventory_asset_account_id,
      COALESCE(v_line.description,'Inventory issue'),
      0,v_total_cost_base,v_currency,1,0,v_total_cost_base,v_line.id::text
    );
  END LOOP;

  IF NOT EXISTS(
    SELECT 1 FROM inventory.inventory_document_lines
    WHERE organization_id=v_org AND document_id=v_doc.id
  ) THEN
    RAISE EXCEPTION 'INVENTORY_DOCUMENT_HAS_NO_LINES';
  END IF;

  IF v_journal IS NOT NULL THEN
    PERFORM accounting.post_journal_entry(v_journal);
  END IF;

  UPDATE inventory.inventory_documents
  SET
    status='posted',
    journal_entry_id=v_journal,
    posted_at=clock_timestamp(),
    posted_by=app.require_user_id()
  WHERE organization_id=v_org AND id=v_doc.id;

  RETURN v_journal;
END
$$;

COMMIT;
