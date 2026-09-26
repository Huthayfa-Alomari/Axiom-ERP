import type { ScaleUnit } from './live-scale.js';

// Kept structural so this package compiles on platforms whose DOM types omit Web Serial.
interface SerialPortLike {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
}
interface SerialOptions {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'hardware';
}
interface SerialNavigator {
  serial?: { requestPort(): Promise<SerialPortLike> };
}

export interface SerialScaleSettings extends SerialOptions {
  defaultUnit: ScaleUnit;
  readingKind: 'gross' | 'net';
  toleranceKg: string;
  maxWeightKg: string;
  maxAgeMs: number;
}

export const defaultSerialScaleSettings: SerialScaleSettings = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  defaultUnit: 'kg',
  readingKind: 'gross',
  toleranceKg: '0.002',
  maxWeightKg: '60',
  maxAgeMs: 2000,
};

export class WebSerialScale {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  private opening = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onStatus: (connected: boolean, error?: string) => void,
  ) {}

  async connect(settings: SerialScaleSettings): Promise<void> {
    if (this.port || this.opening) throw new Error('SCALE_ALREADY_CONNECTED');
    const serial = (navigator as Navigator & SerialNavigator).serial;
    if (!serial) throw new Error('WEB_SERIAL_UNAVAILABLE');
    this.opening = true;
    try {
      // requestPort must be called directly from a user click (transient activation).
      const port = await serial.requestPort();
      await port.open({
        baudRate: settings.baudRate,
        dataBits: settings.dataBits,
        stopBits: settings.stopBits,
        parity: settings.parity,
        flowControl: settings.flowControl,
      });
      if (!port.readable) {
        await port.close();
        throw new Error('SCALE_HAS_NO_READABLE_STREAM');
      }
      this.port = port;
      this.onStatus(true);
      this.loop = this.readLines(port);
    } finally {
      this.opening = false;
    }
  }

  private async readLines(port: SerialPortLike): Promise<void> {
    let error: string | undefined;
    let buffer = '';
    const decoder = new TextDecoder('ascii');
    try {
      this.reader = port.readable!.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Limits both memory and malformed frames; an overflow cannot yield a sale.
        if (buffer.length > 512) buffer = '';
        const frames = buffer.split(/[\r\n]+/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) if (frame.trim()) this.onLine(frame.trim());
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'SCALE_DISCONNECTED';
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      this.port = null;
      try { await port.close(); } catch { /* Device may already be unplugged. */ }
      this.onStatus(false, error);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.port) return;
    await this.reader?.cancel();
    await this.loop;
  }
}
