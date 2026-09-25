export interface BarcodeScannerOptions {
  minLength?: number;
  maxInterKeyDelayMs?: number;
  terminatorKeys?: string[];
}

export class KeyboardBarcodeScanner {
  private buffer = '';
  private lastKeyAt = 0;
  private readonly minLength: number;
  private readonly maxInterKeyDelayMs: number;
  private readonly terminatorKeys: Set<string>;

  constructor(
    private readonly onBarcode: (barcode: string) => void | Promise<void>,
    options: BarcodeScannerOptions = {},
  ) {
    this.minLength = options.minLength ?? 6;
    this.maxInterKeyDelayMs = options.maxInterKeyDelayMs ?? 80;
    this.terminatorKeys = new Set(options.terminatorKeys ?? ['Enter', 'Tab']);
  }

  handleKeyDown = (event: KeyboardEvent): void => {
    const now = performance.now();

    if (now - this.lastKeyAt > this.maxInterKeyDelayMs) {
      this.buffer = '';
    }
    this.lastKeyAt = now;

    if (this.terminatorKeys.has(event.key)) {
      const barcode = this.buffer;
      this.buffer = '';
      if (barcode.length >= this.minLength) {
        event.preventDefault();
        void this.onBarcode(barcode);
      }
      return;
    }

    if (/^\d$/.test(event.key)) {
      this.buffer += event.key;
    }
  };

  attach(target: Document | HTMLElement = document): () => void {
    target.addEventListener('keydown', this.handleKeyDown as EventListener);
    return () => target.removeEventListener('keydown', this.handleKeyDown as EventListener);
  }
}
