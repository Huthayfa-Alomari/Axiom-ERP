'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Cable, CircleAlert, PackagePlus, RefreshCw, Scale, Trash2 } from 'lucide-react';
import { ScaleStabilityTracker, type ScaleState } from '@axiom/pos/live-scale';
import {
  priceLiveScaleLine, totalLiveScaleLines,
  type LiveScaleLine, type WeighableProduct,
} from '@axiom/pos/live-cart';
import {
  WebSerialScale, defaultSerialScaleSettings, type SerialScaleSettings,
} from '@axiom/pos/web-serial';
import styles from './pos.module.css';

type ProductRow = WeighableProduct & { availableQuantity: string };
type Catalog = { settings: SerialScaleSettings | null; products: ProductRow[]; currencyCode: string };

const stateText: Record<ScaleState, string> = {
  waiting: 'بانتظار قراءة الميزان',
  unstable: 'الوزن غير ثابت',
  stable: 'وزن ثابت — جاهز للإضافة',
  zero: 'الميزان فارغ',
  stale: 'القراءة قديمة — افحص الاتصال',
  invalid: 'قراءة غير مفهومة أو خارج سعة الميزان',
};

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    WEB_SERIAL_UNAVAILABLE: 'المتصفح لا يدعم Web Serial. افتح الصفحة من Chrome أو Edge على الكمبيوتر.',
    SCALE_READING_NOT_STABLE: 'انتظر حتى يستقر الوزن قبل إضافته.',
    SCALE_READING_ALREADY_USED: 'أزل السلعة من الميزان ثم ضع السلعة التالية.',
    SCALE_INVALID_NET_WEIGHT_OR_PRICE: 'الوزن الصافي أو سعر الكيلو غير صالح. راجع وزن العبوة.',
    SCALE_PRECISION_EXCEEDS_FOUR_DECIMALS: 'الصنف أو الميزان يتجاوز دقة أربعة منازل عشرية.',
  };
  return known[message] ?? message;
}

export default function PosPage() {
  const [organizationId, setOrganizationId] = useState('');
  const [terminalId, setTerminalId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState(
    process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
  );
  const [settings, setSettings] = useState<SerialScaleSettings>(defaultSerialScaleSettings);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [currencyCode, setCurrencyCode] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [cart, setCart] = useState<LiveScaleLine[]>([]);
  const [state, setState] = useState<ScaleState>('waiting');
  const [readingUsed, setReadingUsed] = useState(false);
  const [weightKg, setWeightKg] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const trackerRef = useRef(new ScaleStabilityTracker({ defaultUnit: 'kg' }));
  const bridgeRef = useRef<WebSerialScale | null>(null);
  const requestRef = useRef(0);
  const selected = products.find(p => p.id === selectedId) ?? null;
  const total = useMemo(() => totalLiveScaleLines(cart), [cart]);

  function clearSession() {
    requestRef.current++;
    setBusy(false);
    void bridgeRef.current?.disconnect();
    trackerRef.current.reset();
    setProducts([]);
    setSelectedId('');
    setCart([]);
    setCurrencyCode('');
    setWeightKg(null);
    setState('waiting');
    setReadingUsed(false);
  }

  useEffect(() => {
    const interval = window.setInterval(() => setState(trackerRef.current.getStatus()), 350);
    return () => {
      window.clearInterval(interval);
      void bridgeRef.current?.disconnect();
    };
  }, []);

  function setTracking(next: SerialScaleSettings) {
    trackerRef.current = new ScaleStabilityTracker({
      defaultUnit: next.defaultUnit,
      toleranceKg: next.toleranceKg,
      maxWeightKg: next.maxWeightKg,
      maxAgeMs: next.maxAgeMs,
    });
    setState('waiting');
    setWeightKg(null);
    setReadingUsed(false);
  }

  async function loadCatalog() {
    const requestId = ++requestRef.current;
    setBusy(true);
    setMessage('');
    try {
      const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/pos/terminals/${terminalId}/live-scale`;
      const response = await fetch(endpoint, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-organization-id': organizationId,
        },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`تعذّر تحميل الأصناف (${response.status}). تحقق من الصلاحية والاتصال.`);
      const catalog = await response.json() as Catalog;
      if (requestId !== requestRef.current) return;
      const nextSettings = catalog.settings ?? defaultSerialScaleSettings;
      if (connected) await bridgeRef.current?.disconnect();
      setSettings(nextSettings);
      setTracking(nextSettings);
      setProducts(catalog.products);
      setCurrencyCode(catalog.currencyCode);
      setSelectedId(catalog.products[0]?.id ?? '');
      setCart([]);
      setMessage(catalog.products.length ? 'تم تحميل أصناف الكيلو وإعدادات الميزان.' :
        'لا توجد أصناف كيلو مفعّلة لهذه المؤسسة. أضفها من واجهة الإدارة البرمجية.');
    } catch (error) {
      if (requestId === requestRef.current) setMessage(friendlyError(error));
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }

  async function connect() {
    setMessage('');
    try {
      const bridge = new WebSerialScale(
        line => {
          const current = trackerRef.current;
          setState(current.observe(line));
          setWeightKg(current.getWeightKg());
          setReadingUsed(current.isConsumed());
        },
        (isConnected, error) => {
          setConnected(isConnected);
          if (!isConnected) {
            trackerRef.current.reset();
            setWeightKg(null);
            setState('waiting');
            setReadingUsed(false);
          }
          if (error) setMessage(`انقطع اتصال الميزان: ${error}`);
        },
      );
      bridgeRef.current = bridge;
      await bridge.connect(settings);
    } catch (error) {
      bridgeRef.current = null;
      setMessage(friendlyError(error));
    }
  }

  function addWeight() {
    if (!selected) return;
    try {
      const at = Date.now();
      // Calculate first: a failed price/tare check must not consume the reading.
      const line = priceLiveScaleLine(selected, trackerRef.current.peek(at), settings.readingKind);
      trackerRef.current.capture(at);
      setReadingUsed(true);
      setCart(old => [...old, line]);
      setMessage('تمت إضافة الوزنة. أزل السلعة من الميزان لإضافة وزنة جديدة.');
    } catch (error) {
      setMessage(friendlyError(error));
    }
  }

  return <div className={styles.page} dir="rtl">
    <header className={styles.heading}>
      <div><span className={styles.eyebrow}>AXIOM / POINT OF SALE</span>
        <h1>نقطة البيع والميزان</h1>
        <p>اقرأ الوزن من الميزان مباشرة، وراجع وزن العبوة وسعر الكيلو قبل إضافة الصنف.</p>
      </div>
      <span className={`${styles.connection} ${connected ? styles.connected : ''}`}>
        <span className={styles.dot} />{connected ? 'الميزان متصل' : 'الميزان غير متصل'}
      </span>
    </header>

    <section className={styles.setup} aria-label="ربط مؤسسة ونقطة بيع">
      <div className={styles.sectionTitle}><Cable size={19} aria-hidden="true" /><h2>إعداد نقطة البيع</h2></div>
      <p className={styles.help}>المفتاح يبقى داخل هذه الصفحة فقط. يحتاج الحساب صلاحية <code>pos.scale.read</code>.</p>
      <div className={styles.setupGrid}>
        <label>عنوان API<input value={apiBaseUrl} onChange={e => { clearSession(); setApiBaseUrl(e.target.value); }} placeholder="http://localhost:3001" /></label>
        <label>معرّف المؤسسة<input value={organizationId} onChange={e => { clearSession(); setOrganizationId(e.target.value); }} placeholder="UUID" spellCheck={false} /></label>
        <label>معرّف الصندوق<input value={terminalId} onChange={e => { clearSession(); setTerminalId(e.target.value); }} placeholder="UUID" spellCheck={false} /></label>
        <label>رمز دخول الكاشير<input type="password" value={accessToken} onChange={e => { clearSession(); setAccessToken(e.target.value); }} autoComplete="off" placeholder="Bearer JWT" /></label>
      </div>
      <button type="button" className={styles.secondary} onClick={loadCatalog}
        disabled={busy || !organizationId || !terminalId || !accessToken}>
        <RefreshCw size={17} aria-hidden="true" />{busy ? 'جاري التحميل…' : 'تحميل الأصناف والإعدادات'}
      </button>
    </section>

    <div className={styles.columns}>
      <section className={styles.scalePanel} aria-label="الميزان">
        <div className={styles.sectionTitle}><Scale size={20} aria-hidden="true" /><h2>قراءة الوزن</h2></div>
        <div className={styles.scaleScreen} role="status" aria-live="polite">
          <span>الوزن المقروء</span><strong>{weightKg ?? '0.000'} <small>كغ</small></strong>
          <div className={`${styles.readingState} ${state === 'stable' && !readingUsed ? styles.ready : ''}`}>
            {readingUsed ? 'أزل السلعة وانتظر عودة الميزان للصفر' : stateText[state]}
          </div>
        </div>
        <div className={styles.scaleControls}>
          <label>سرعة المنفذ
            <select value={settings.baudRate} disabled={connected}
              onChange={e => { const next = { ...settings, baudRate: Number(e.target.value) }; setSettings(next); setTracking(next); }}>
              {[2400, 4800, 9600, 19200, 38400, 57600, 115200].map(rate =>
                <option key={rate} value={rate}>{rate} baud</option>)}</select>
          </label>
          <label>وحدة الجهاز
            <select value={settings.defaultUnit} disabled={connected}
              onChange={e => { const next = { ...settings, defaultUnit: e.target.value as 'kg' | 'g' }; setSettings(next); setTracking(next); }}>
              <option value="kg">كيلوغرام</option><option value="g">غرام</option>
            </select>
          </label>
        </div>
        {connected ?
          <button className={styles.secondary} type="button" onClick={() => void bridgeRef.current?.disconnect()}>فصل الميزان</button> :
          <button className={styles.primary} type="button" onClick={connect}><Cable size={18} aria-hidden="true" />اختيار منفذ الميزان</button>}
        <p className={styles.help}>يتطلب Chrome أو Edge على الكمبيوتر واتصال HTTPS أو localhost. اضغط الزر واختر منفذ USB/RS‑232 من نافذة المتصفح.</p>
      </section>

      <section className={styles.cartPanel} aria-label="معاينة سلة الأوزان">
        <div className={styles.sectionTitle}><PackagePlus size={20} aria-hidden="true" /><h2>إضافة صنف بالكيلو</h2></div>
        <label className={styles.productSelect}>الصنف
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            {products.length === 0 && <option value="">حمّل أصناف الكيلو أولًا</option>}
            {products.map(product => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}
          </select>
        </label>
        {selected && <div className={styles.productDetails}>
          <div><span>سعر الكيلو</span><strong>{selected.salePrice} {currencyCode}</strong></div>
          <div><span>وزن العبوة</span><strong>{settings.readingKind === 'gross' ? selected.tareWeight : '0'} كغ</strong></div>
          <div><span>المخزون المتاح</span><strong>{selected.availableQuantity} كغ</strong></div>
        </div>}
        <button className={styles.primary} type="button" onClick={addWeight}
          disabled={!connected || !selected || state !== 'stable' || readingUsed}>
          <PackagePlus size={18} aria-hidden="true" />إضافة الوزنة الثابتة
        </button>
        <div className={styles.cartHeader}><h3>الأوزان المضافة</h3><span>{cart.length} صنف</span></div>
        {cart.length === 0 ? <div className={styles.empty}>ضع السلعة على الميزان، وانتظر ثبات الوزن، ثم أضفها.</div> :
          <ul className={styles.lines}>{cart.map(line =>
            <li key={line.id}>
              <div><strong>{line.product.name}</strong><span>{line.quantity} كغ × {line.unitPrice} {currencyCode} / كغ</span></div>
              <strong>{line.lineTotal} {currencyCode}</strong>
              <button type="button" aria-label={`حذف ${line.product.name} من المعاينة`} title="حذف من المعاينة"
                onClick={() => setCart(old => old.filter(item => item.id !== line.id))}>
                <Trash2 size={18} aria-hidden="true" />
              </button>
            </li>)}</ul>}
        <div className={styles.total}><span>مجموع المعاينة</span><strong>{total} <small>{currencyCode}</small></strong></div>
        <p className={styles.help}>هذه معاينة محلية للوزن والسعر؛ لم تُنشأ فاتورة أو حركة مخزون أو قيد محاسبي.</p>
      </section>
    </div>
    {message && <div className={styles.message} role="alert"><CircleAlert size={18} aria-hidden="true" />{message}</div>}
  </div>;
}
