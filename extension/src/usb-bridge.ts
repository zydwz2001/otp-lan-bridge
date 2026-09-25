import { Adb, AdbDaemonTransport, type AdbSocket } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager, type AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import { BridgeFrameDecoder, encodeBridgeFrame, type BridgeSocket } from "./bridge-transport";

const USB_BRIDGE_SERVICE = "tcp:42872";
const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
const connections = new Map<string, Promise<Adb>>();
const streamCounts = new Map<string, number>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const credentials = new AdbWebCredentialStore("VerificationCodeTransfer");

export function usbDeviceKey(device: { vendorId: number; productId: number; serialNumber?: string | null }): string {
  return `${device.vendorId}:${device.productId}:${device.serialNumber ?? ""}`;
}

export async function usbDeviceKeys(): Promise<string[]> {
  try { return (await manager?.getDevices() ?? []).map((device) => usbDeviceKey(device.raw)); }
  catch { return []; }
}

/** Must be called synchronously from a click in an extension-owned document. */
export function requestUsbDevice(): Promise<string | undefined> {
  if (!manager) return Promise.resolve(undefined);
  return manager.requestDevice().then((device) => device ? usbDeviceKey(device.raw) : undefined);
}

export function onUsbDevicesChanged(callback: () => void): void {
  globalThis.navigator?.usb?.addEventListener("connect", callback);
  globalThis.navigator?.usb?.addEventListener("disconnect", callback);
}

function timeout<T>(operation: Promise<T>, ms: number, cancel: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cancel();
      reject(new Error("手机连接或授权超时"));
    }, ms);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function connectAdb(device: AdbDaemonWebUsbDevice, timeoutMs: number): Promise<Adb> {
  const key = usbDeviceKey(device.raw);
  const existing = connections.get(key);
  if (existing) return existing;
  let cancelled = false;
  const run = (async () => {
    const connection = await device.connect();
    if (cancelled) throw new Error("Connection cancelled");
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: credentials,
      initialDelayedAckBytes: 0
    });
    const adb = new Adb(transport);
    if (cancelled) {
      await adb.close();
      throw new Error("Connection cancelled");
    }
    void adb.disconnected.catch(() => undefined).then(() => {
      if (connections.get(key) === pending) connections.delete(key);
    });
    return adb;
  })();
  const pending = timeout(run, timeoutMs, () => {
    cancelled = true;
    void device.raw.close().catch(() => undefined);
  }).catch(async (error: unknown) => {
    cancelled = true;
    if (connections.get(key) === pending) connections.delete(key);
    try { await device.raw.close(); } catch { /* Detached or already closed. */ }
    throw error;
  });
  connections.set(key, pending);
  return pending;
}

export async function openUsbSocket(key: string, timeoutMs = 4_000): Promise<BridgeSocket> {
  const devices = await manager?.getDevices() ?? [];
  const device = devices.find((candidate) => usbDeviceKey(candidate.raw) === key);
  if (!device) throw new Error("手机未连接");
  clearTimeout(idleTimers.get(key));
  idleTimers.delete(key);
  const adb = await connectAdb(device, timeoutMs);
  clearTimeout(idleTimers.get(key));
  idleTimers.delete(key);
  streamCounts.set(key, (streamCounts.get(key) ?? 0) + 1);
  const release = (): void => {
    streamCounts.set(key, Math.max(0, (streamCounts.get(key) ?? 1) - 1));
    if (streamCounts.get(key)) return;
    idleTimers.set(key, setTimeout(() => {
      idleTimers.delete(key);
      if (streamCounts.get(key)) return;
      streamCounts.delete(key);
      const pending = connections.get(key);
      connections.delete(key);
      void pending?.then((connection) => connection.close()).catch(() => undefined);
    }, 5_000));
  };
  try {
    const stream = await timeout(adb.createSocket(USB_BRIDGE_SERVICE), 3_000, () => {
      void adb.close().catch(() => undefined);
    });
    return new UsbMessageSocket(stream, key, release);
  } catch (error) { release(); throw error; }
}

class UsbMessageSocket implements BridgeSocket {
  readonly transport = "usb" as const;
  readyState = 0;
  onopen: BridgeSocket["onopen"] = null;
  onmessage: BridgeSocket["onmessage"] = null;
  onerror: BridgeSocket["onerror"] = null;
  onclose: BridgeSocket["onclose"] = null;
  private readonly reader;
  private readonly writer;
  private writes: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly stream: AdbSocket, readonly deviceKey: string, private readonly release: () => void) {
    this.reader = stream.readable.getReader();
    this.writer = stream.writable.getWriter();
    void stream.closed.then(() => this.close(), () => this.close());
  }

  start(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      this.onopen?.(new Event("open"));
      void this.read();
    });
  }

  private async read(): Promise<void> {
    const decoder = new BridgeFrameDecoder();
    try {
      while (this.readyState === 1) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        for (const message of decoder.push(chunk.value)) {
          if (this.readyState !== 1) break;
          this.onmessage?.(new MessageEvent("message", { data: message }));
        }
      }
    } catch { this.onerror?.(new Event("error")); }
    finally { this.close(); }
  }

  send(message: string): void {
    if (this.readyState !== 1 || this.queued >= 32) throw new Error("手机当前离线");
    const frame = encodeBridgeFrame(message);
    this.queued++;
    this.writes = this.writes.then(async () => {
      if (this.readyState === 1) await this.writer.write(frame);
    }).catch(() => {
      this.onerror?.(new Event("error"));
      this.close();
    }).finally(() => { this.queued--; });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.release();
    // Cancel the reader as well: a pending ADB socket close must not stall the
    // multiplexed transport while waiting for an unread final packet.
    void this.reader.cancel().catch(() => undefined);
    void Promise.resolve(this.stream.close()).catch(() => undefined);
    this.onclose?.(new Event("close") as CloseEvent);
  }
}
