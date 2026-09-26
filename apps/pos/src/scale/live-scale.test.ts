import { describe, expect, it } from 'vitest';
import { parseScaleFrame, ScaleStabilityTracker } from './live-scale.js';
import { priceLiveScaleLine, totalLiveScaleLines, type WeighableProduct } from './live-cart.js';

const product: WeighableProduct = {
  id: 'test-product', sku: 'APPLES-KG', name: 'Apples', unitCode: 'KG',
  salePrice: '2.7500', tareWeight: '0.0250',
};

describe('live serial scale', () => {
  it('accepts explicitly stable kg and g frames and rejects overload/unstable flags', () => {
    expect(parseScaleFrame('ST,GS,+0.750 kg', 'g')).toMatchObject({
      weightKg: '0.75', deviceUnit: 'kg', declaredStable: true, readingKind: 'gross',
    });
    expect(parseScaleFrame('ST,NT,750 g', 'kg')).toMatchObject({
      weightKg: '0.75', deviceUnit: 'g', readingKind: 'net',
    });
    expect(parseScaleFrame('US,GS,0.750 kg', 'kg')?.declaredStable).toBe(false);
    for (const bad of ['OL', '-0.200 kg', '2,000 kg', 'ERR 12', 'ST,GS,0.9 lb']) {
      expect(parseScaleFrame(bad, 'kg')).toBeNull();
    }
  });

  it('requires several steady samples, blocks stale/duplicate readings and rearms at zero', () => {
    const tracker = new ScaleStabilityTracker({ defaultUnit: 'kg', maxAgeMs: 1000 });
    expect(tracker.observe('ST,GS,0.800 kg', 1000)).toBe('unstable');
    expect(tracker.observe('ST,GS,0.801 kg', 1100)).toBe('unstable');
    expect(tracker.observe('ST,GS,0.800 kg', 1200)).toBe('stable');
    expect(tracker.getStatus(2201)).toBe('stale');
    expect(() => tracker.capture(2201)).toThrow('SCALE_READING_NOT_STABLE');
    tracker.observe('ST,GS,0.800 kg', 2300);
    tracker.observe('ST,GS,0.800 kg', 2400);
    tracker.observe('ST,GS,0.800 kg', 2500);
    expect(tracker.capture(2500).weightKg).toBe('0.8');
    expect(() => tracker.capture(2501)).toThrow('SCALE_READING_ALREADY_USED');
    tracker.observe('0.000 kg', 2600);
    tracker.observe('0.000 kg', 2700);
    tracker.observe('0.000 kg', 2800);
    tracker.observe('ST,GS,0.750 kg', 2900);
    tracker.observe('ST,GS,0.750 kg', 3000);
    tracker.observe('ST,GS,0.750 kg', 3100);
    expect(tracker.capture(3100).weightKg).toBe('0.75');
  });

  it('resets stability on moving and invalid readings', () => {
    const tracker = new ScaleStabilityTracker({ defaultUnit: 'kg', maxWeightKg: '30' });
    tracker.observe('0.750 kg', 100);
    tracker.observe('0.751 kg', 200);
    expect(tracker.observe('US,GS,0.750 kg', 300)).toBe('unstable');
    expect(tracker.observe('0.750 kg', 400)).toBe('unstable');
    expect(tracker.observe('OL', 500)).toBe('invalid');
    expect(tracker.observe('31.000 kg', 600)).toBe('invalid');
    expect(() => tracker.capture(600)).toThrow();
  });

  it('subtracts packaging once from gross, preserves net and uses four-place money', () => {
    const tracker = new ScaleStabilityTracker({ defaultUnit: 'kg' });
    for (let at = 100; at <= 300; at += 100) tracker.observe('ST,GS,0.750 kg', at);
    const line = priceLiveScaleLine(product, tracker.capture(300), 'gross');
    expect(line.quantity).toBe('0.725');
    expect(line.lineTotal).toBe('1.9938');
    expect(line.scanMetadata.tareWeightKg).toBe('0.025');
    expect(totalLiveScaleLines([line, line])).toBe('3.9876');
    for (let at = 400; at <= 600; at += 100) tracker.observe('0 kg', at);
    for (let at = 700; at <= 900; at += 100) tracker.observe('ST,NT,0.750 kg', at);
    const netLine = priceLiveScaleLine(product, tracker.capture(900), 'gross');
    expect(netLine.quantity).toBe('0.75');
    expect(netLine.scanMetadata.tareWeightKg).toBe('0');
  });

  it('rejects tare larger than gross and unsupported base units', () => {
    const tracker = new ScaleStabilityTracker({ defaultUnit: 'kg' });
    for (let at = 100; at <= 300; at += 100) tracker.observe('ST,GS,0.010 kg', at);
    expect(() => priceLiveScaleLine(product, tracker.peek(300), 'gross')).toThrow();
    expect(() => priceLiveScaleLine({ ...product, unitCode: 'G' }, tracker.peek(300), 'gross'))
      .toThrow('SCALE_PRODUCT_MUST_USE_KILOGRAMS');
  });
});
