import Decimal from 'decimal.js';

export type ScaleUnit = 'kg' | 'g';
export type ScaleReadingKind = 'gross' | 'net';

export interface ScaleFrame {
  weightKg: string;
  deviceUnit: ScaleUnit;
  declaredStable: boolean | null;
  readingKind: ScaleReadingKind | null;
}

export interface StableScaleReading extends ScaleFrame {
  capturedAt: string;
  stableSamples: number;
}

export type ScaleState = 'waiting' | 'unstable' | 'stable' | 'zero' | 'stale' | 'invalid';

// Deliberately accept a small, anchored ASCII protocol. Unrecognized frames must
// never turn into a weight (many scales send error/overload codes on the same port).
export function parseScaleFrame(line: string, defaultUnit: ScaleUnit): ScaleFrame | null {
  if (line.length > 80 || !/^[\x20-\x7e]*$/.test(line)) return null;
  const match = line.trim().match(
    /^(?:(ST|US|S|U)\s*[, ]\s*)?(?:(GS|NT)\s*[, ]\s*)?([+-]?\d+(?:\.\d{1,4})?)\s*(kg|g)?$/i,
  );
  if (!match) return null;
  const raw = new Decimal(match[3]!);
  const unit = (match[4]?.toLowerCase() ?? defaultUnit) as ScaleUnit;
  const kg = unit === 'g' ? raw.div(1000) : raw;
  if (kg.isNegative() || kg.decimalPlaces() > 4) return null;
  return {
    weightKg: kg.toFixed(),
    deviceUnit: unit,
    declaredStable: match[1] ? ['ST', 'S'].includes(match[1].toUpperCase()) : null,
    readingKind: match[2] ? (match[2].toUpperCase() === 'NT' ? 'net' : 'gross') : null,
  };
}

export class ScaleStabilityTracker {
  private samples: { frame: ScaleFrame; at: number }[] = [];
  private state: ScaleState = 'waiting';
  private consumed = false;
  private zeroSamples = 0;
  private lastZeroAt = 0;

  constructor(private readonly options: {
    defaultUnit: ScaleUnit;
    samplesRequired?: number;
    toleranceKg?: string;
    maxWeightKg?: string;
    maxAgeMs?: number;
  }) {
    if ((options.samplesRequired ?? 3) < 3 || (options.maxAgeMs ?? 2000) < 250) {
      throw new Error('INVALID_SCALE_STABILITY_CONFIGURATION');
    }
  }

  observe(line: string, at = Date.now()): ScaleState {
    const frame = parseScaleFrame(line, this.options.defaultUnit);
    if (!frame || new Decimal(frame.weightKg).gt(this.options.maxWeightKg ?? '60')) {
      this.samples = [];
      this.state = 'invalid';
      return this.state;
    }
    if (frame.declaredStable === false) {
      this.samples = [];
      this.zeroSamples = 0;
      this.state = 'unstable';
      return this.state;
    }
    if (new Decimal(frame.weightKg).isZero()) {
      if (at - this.lastZeroAt > (this.options.maxAgeMs ?? 2000)) this.zeroSamples = 0;
      this.lastZeroAt = at;
      this.zeroSamples++;
      this.samples = [];
      // A single zero glitch must not rearm the same item for another charge.
      if (this.zeroSamples >= (this.options.samplesRequired ?? 3)) this.consumed = false;
      this.state = 'zero';
      return this.state;
    }
    this.zeroSamples = 0;
    const last = this.samples.at(-1);
    if (last && (at < last.at || at - last.at > (this.options.maxAgeMs ?? 2000))) {
      this.samples = [];
    }
    this.samples.push({ frame, at });
    const count = this.options.samplesRequired ?? 3;
    this.samples = this.samples.slice(-count);
    const weights = this.samples.map(sample => new Decimal(sample.frame.weightKg));
    const steady = this.samples.length === count &&
      Decimal.max(...weights).minus(Decimal.min(...weights)).lte(this.options.toleranceKg ?? '0.002');
    this.state = steady ? 'stable' : 'unstable';
    return this.state;
  }

  getStatus(at = Date.now()): ScaleState {
    const last = this.samples.at(-1);
    return last && at - last.at > (this.options.maxAgeMs ?? 2000) ? 'stale' : this.state;
  }

  getWeightKg(): string | null {
    return this.state === 'zero' ? '0' : this.samples.at(-1)?.frame.weightKg ?? null;
  }

  isConsumed(): boolean { return this.consumed; }

  peek(at = Date.now()): StableScaleReading {
    if (this.getStatus(at) !== 'stable') throw new Error('SCALE_READING_NOT_STABLE');
    if (this.consumed) throw new Error('SCALE_READING_ALREADY_USED');
    const frame = this.samples.at(-1)!.frame;
    return { ...frame, capturedAt: new Date(at).toISOString(), stableSamples: this.samples.length };
  }

  capture(at = Date.now()): StableScaleReading {
    const reading = this.peek(at);
    this.consumed = true;
    return reading;
  }

  reset(): void {
    this.samples = [];
    this.consumed = false;
    this.zeroSamples = 0;
    this.lastZeroAt = 0;
    this.state = 'waiting';
  }
}
