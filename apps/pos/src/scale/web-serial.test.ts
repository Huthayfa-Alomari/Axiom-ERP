import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSerialScale, defaultSerialScaleSettings } from './web-serial.js';

afterEach(() => vi.unstubAllGlobals());

describe('Web Serial scale bridge', () => {
  it('assembles readings split across USB packets and closes the port', async () => {
    const received: string[] = [];
    const status: boolean[] = [];
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder();
        controller.enqueue(bytes.encode('ST,GS,+0.7'));
        controller.enqueue(bytes.encode('50 kg\r\nUS,GS,0.8'));
        controller.enqueue(bytes.encode('00 kg\r\n'));
        controller.close();
      },
    });
    const port = { open: vi.fn(), close: vi.fn(), readable };
    vi.stubGlobal('navigator', { serial: { requestPort: async () => port } });

    const bridge = new WebSerialScale(line => received.push(line), connected => status.push(connected));
    await bridge.connect(defaultSerialScaleSettings);
    await vi.waitFor(() => expect(status).toEqual([true, false]));

    expect(port.open).toHaveBeenCalledWith(expect.objectContaining({ baudRate: 9600 }));
    expect(received).toEqual(['ST,GS,+0.750 kg', 'US,GS,0.800 kg']);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('does not silently connect when Web Serial is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const bridge = new WebSerialScale(() => {}, () => {});
    await expect(bridge.connect(defaultSerialScaleSettings)).rejects.toThrow('WEB_SERIAL_UNAVAILABLE');
  });
});
