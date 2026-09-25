/** Both transports carry exactly the same pairing and encrypted application messages. */
export interface BridgeSocket {
  readonly readyState: number;
  readonly transport?: "usb";
  readonly deviceKey?: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  start?(): void;
}

export const MAX_FRAME_BYTES = 32 * 1024;

export function encodeBridgeFrame(message: string): Uint8Array {
  const payload = new TextEncoder().encode(message);
  if (!payload.length || payload.length > MAX_FRAME_BYTES) throw new Error("Invalid frame size");
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length);
  frame.set(payload, 4);
  return frame;
}

export class BridgeFrameDecoder {
  private pending: Uint8Array = new Uint8Array();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Uint8Array): string[] {
    const data = new Uint8Array(this.pending.length + chunk.length);
    data.set(this.pending);
    data.set(chunk, this.pending.length);
    const messages: string[] = [];
    let offset = 0;
    while (data.length - offset >= 4) {
      const length = new DataView(data.buffer, offset, 4).getUint32(0);
      if (!length || length > MAX_FRAME_BYTES) throw new Error("Invalid frame size");
      if (data.length - offset < length + 4) break;
      messages.push(this.decoder.decode(data.subarray(offset + 4, offset + 4 + length)));
      offset += length + 4;
    }
    this.pending = data.slice(offset);
    return messages;
  }
}
