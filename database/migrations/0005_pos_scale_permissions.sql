BEGIN;

INSERT INTO app.role_permissions(organization_id,role_id,permission_code)
SELECT r.organization_id,r.id,'pos.scale.read'
FROM app.roles r
WHERE upper(r.code) IN ('ORG_ADMIN','POS_CASHIER','STORE_MANAGER','ACCOUNTANT')
ON CONFLICT DO NOTHING;

INSERT INTO app.role_permissions(organization_id,role_id,permission_code)
SELECT r.organization_id,r.id,'pos.scale.configure'
FROM app.roles r
WHERE upper(r.code) IN ('ORG_ADMIN','STORE_MANAGER')
ON CONFLICT DO NOTHING;

COMMIT;
