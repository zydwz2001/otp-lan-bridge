// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bytesToBase64, decryptEnvelope, derivePairingKey, deriveSessionKey, encryptEnvelope,
  exportPublicKey, generatePairingKeyPair, hmac } from "../src/crypto";
import type { BridgeSocket } from "../src/bridge-transport";
import type { Envelope } from "../src/types";
import { onUsbDevicesChanged, openUsbSocket, usbDeviceKeys } from "../src/usb-bridge";

vi.mock("../src/usb-bridge", () => ({
  onUsbDevicesChanged: vi.fn(), openUsbSocket: vi.fn(), usbDeviceKeys: vi.fn()
}));

const deviceId = "ca8f82b4-12b4-4dc8-954f-52b50db52ea1";
let pairingKey: Uint8Array;
let availableKeys: string[];
let sockets: PhoneSocket[];
let changeDevices: () => void;
let local: Record<string, any>;
let session: Record<string, any>;
let listener: (message: Record<string, unknown>, sender: chrome.runtime.MessageSender, reply: (data: any) => void) => boolean;

class PhoneSocket implements BridgeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly transport?: "usb";
  readyState = 0;
  onopen: BridgeSocket["onopen"] = null;
  onclose: BridgeSocket["onclose"] = null;
  onmessage: BridgeSocket["onmessage"] = null;
  onerror: BridgeSocket["onerror"] = null;
  key?: Uint8Array;
  sessionId = crypto.randomUUID();
  seq = 0;
  requestId = "";
  authenticated = false;
  private work = Promise.resolve();

  constructor(readonly deviceKey?: string, readonly url?: string) {
    this.transport = deviceKey ? "usb" : undefined;
    sockets.push(this);
  }
  start(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(new Event("close") as CloseEvent);
  }
  send(raw: string): void {
    this.work = this.work.then(() => this.respond(JSON.parse(raw))).catch(() => this.close());
  }
  private emit(message: unknown): void {
    if (this.readyState === 1) this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  private async respond(message: Record<string, any>): Promise<void> {
    if (message.type === "PAIR_INIT") {
      if (message.pairCode !== "123456") { this.emit({ type: "ERROR", message: "配对码无效或已过期" }); return; }
      const pair = await generatePairingKeyPair();
      const publicKey = await exportPublicKey(pair.publicKey);
      pairingKey = await derivePairingKey(pair.privateKey, message.clientPublicKey, message.pairCode);
      const proof = bytesToBase64(await hmac(pairingKey, `${message.clientPublicKey}|${publicKey}|${deviceId}|${message.clientId}`));
      this.emit({ type: "PAIR_OK", deviceId, serverPublicKey: publicKey, proof });
    } else if (message.type === "AUTH_INIT") {
      const serverNonce = bytesToBase64(new Uint8Array(16).fill(8));
      const transcript = `${deviceId}|${message.clientId}|${this.sessionId}|${message.clientNonce}|${serverNonce}`;
      const proofKey = this.deviceKey === "wrong-phone" ? new Uint8Array(32).fill(99) : pairingKey;
      this.key = await deriveSessionKey(pairingKey, message.clientNonce, serverNonce, this.sessionId);
      this.emit({ type: "AUTH_CHALLENGE", deviceId, sessionId: this.sessionId, serverNonce,
        proof: bytesToBase64(await hmac(proofKey, transcript)) });
    } else if (message.ciphertext && this.key) {
      const payload = await decryptEnvelope(message as Envelope, this.key);
      if (message.type === "ACK" && payload.kind === "AUTH_OK") {
        this.authenticated = true;
        await this.encrypted("ACK", { kind: "STATUS", hostAddress: "", notificationAccess: true });
      } else if (message.type === "ARM") {
        this.requestId = String(payload.requestId);
        await this.encrypted("ACK", { kind: "ARMED", requestId: this.requestId });
      } else if (message.type === "PING") await this.encrypted("PONG", {});
    }
  }
  async encrypted(type: Envelope["type"], payload: unknown): Promise<void> {
    this.emit(await encryptEnvelope(type, deviceId, this.sessionId, ++this.seq, Date.now(), payload, this.key!));
  }
}

beforeEach(() => {
  vi.resetModules();
  pairingKey = new Uint8Array(32).fill(7);
  sockets = [];
  availableKeys = ["phone"];
  local = { wifiRelayConfigV2: { host: "", port: 0, clientId: "browser-client-id", deviceId,
    pairingKey: bytesToBase64(pairingKey), phoneNumber: "13800138000" } };
  session = {};
  vi.mocked(usbDeviceKeys).mockImplementation(async () => [...availableKeys]);
  vi.mocked(openUsbSocket).mockImplementation(async (key) => new PhoneSocket(key));
  vi.mocked(onUsbDevicesChanged).mockImplementation((callback) => { changeDevices = callback; });
  class WifiSocket extends PhoneSocket {
    constructor(url: string) { super(undefined, url); this.start(); }
  }
  vi.stubGlobal("WebSocket", WifiSocket);
  const event = { addListener: vi.fn() };
  vi.stubGlobal("chrome", {
    runtime: { id: "test", onInstalled: event, onStartup: event,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: vi.fn((callback) => { listener = callback; }) } },
    storage: {
      local: { get: vi.fn(async () => local), set: vi.fn(async (value) => { Object.assign(local, structuredClone(value)); }) },
      session: { get: vi.fn(async () => session), set: vi.fn(async (value) => { Object.assign(session, structuredClone(value)); }) }
    },
    alarms: { get: vi.fn(async () => undefined), create: vi.fn(), clear: vi.fn(async () => true), onAlarm: event },
    tabs: { onRemoved: event, onUpdated: event, onActivated: event, query: vi.fn(async () => []), sendMessage: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    windows: { onRemoved: event, onFocusChanged: event, create: vi.fn(async () => ({ id: 9, tabs: [{ id: 90 }] })), remove: vi.fn() },
    webNavigation: { getAllFrames: vi.fn(async () => []) }
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function message(value: Record<string, unknown>, sender = { id: "test", frameId: 0, tab: { id: 7, url: "https://example.com" }, url: "https://example.com" }): Promise<any> {
  return new Promise((resolve) => listener(value, sender as chrome.runtime.MessageSender, resolve));
}

it("pairs over USB with empty or invalid Wi-Fi fields and retains the last Wi-Fi configuration", async () => {
  delete local.wifiRelayConfigV2.pairingKey;
  delete local.wifiRelayConfigV2.deviceId;
  local.wifiRelayConfigV2.host = "192.168.18.52";
  local.wifiRelayConfigV2.port = 42871;
  await import("../src/background");
  expect(await message({ type: "PREPARE_CONNECTION", host: "", port: 0 })).toMatchObject({ ok: true, ready: true });
  expect(await message({ type: "PAIR", host: "not-an-ip", port: -1, pairCode: "123456" })).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(session.wifiRelayRuntimeV2.connection).toBe("online"));
  expect(local.wifiRelayConfigV2).toMatchObject({ host: "192.168.18.52", port: 42871, deviceId, usbDeviceKey: "phone" });
  expect(sockets.every((socket) => socket.transport === "usb")).toBe(true);
  await message({ type: "UNPAIR" });
});

it("rejects an incorrect pairing code even with a working USB connection", async () => {
  delete local.wifiRelayConfigV2.pairingKey;
  await import("../src/background");
  await message({ type: "PREPARE_CONNECTION", host: "", port: 0 });
  expect(await message({ type: "PAIR", host: "", port: 0, pairCode: "000000" })).toMatchObject({ ok: false });
  expect(local.wifiRelayConfigV2.pairingKey).toBeUndefined();
});

it("authenticates USB with no Wi-Fi address and ignores another authorized phone", async () => {
  availableKeys = ["wrong-phone", "phone"];
  await import("../src/background");
  await vi.waitFor(() => expect(session.wifiRelayRuntimeV2.connection).toBe("online"));
  expect(sockets.filter((socket) => socket.authenticated).map((socket) => socket.deviceKey)).toEqual(["phone"]);
  expect(sockets.some((socket) => socket.url)).toBe(false);
  await message({ type: "UNPAIR" });
});

it("switches Wi-Fi to USB and falls back after unplugging while preserving the active wait", async () => {
  availableKeys = [];
  local.wifiRelayConfigV2.host = "192.168.18.52";
  local.wifiRelayConfigV2.port = 42871;
  await import("../src/background");
  await vi.waitFor(() => expect(session.wifiRelayRuntimeV2.connection).toBe("online"));
  await message({ type: "UI_REARM" });
  const requestId = session.wifiRelayRuntimeV2.requestId;
  availableKeys = ["phone"];
  changeDevices();
  await vi.waitFor(() => expect(sockets.some((socket) => socket.transport === "usb" && socket.requestId === requestId)).toBe(true));
  const active = sockets.find((socket) => socket.transport === "usb" && socket.authenticated)!;
  availableKeys = [];
  active.close();
  changeDevices();
  await vi.waitFor(() => expect(sockets.filter((socket) => !socket.transport && socket.requestId === requestId)).toHaveLength(2));
  expect(session.wifiRelayRuntimeV2).toMatchObject({ connection: "online", requestId });
  expect(local.wifiRelayConfigV2).toMatchObject({ host: "192.168.18.52", port: 42871 });
  await message({ type: "UNPAIR" });
});

it("does not allow content scripts to invoke the USB authorization endpoint", async () => {
  delete local.wifiRelayConfigV2.pairingKey;
  await import("../src/background");
  const callsBefore = vi.mocked(openUsbSocket).mock.calls.length;
  expect(await message({ type: "PROBE_USB_CONNECTION", token: crypto.randomUUID(), deviceKey: "phone" })).toMatchObject({ ok: false });
  expect(vi.mocked(openUsbSocket).mock.calls).toHaveLength(callsBefore);
});

it("uses a claimed USB permit only once and keeps it bound to the originating tab", async () => {
  delete local.wifiRelayConfigV2.pairingKey;
  await import("../src/background");
  const token = crypto.randomUUID();
  const permissionPage = { id: "test", frameId: 0, tab: { id: 90, url: "chrome-extension://test/pair-permission.html" }, url: "chrome-extension://test/pair-permission.html" };
  expect(await message({ type: "AUTHORIZE_LOCAL_NETWORK_PROBE", token, host: "", port: 0 })).toMatchObject({ ok: true });
  expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({
    type: "normal", focused: true,
    url: `chrome-extension://test/pair-permission.html#${encodeURIComponent(token)}`
  }));
  expect(await message({ type: "CLAIM_LOCAL_NETWORK_PROBE", token }, permissionPage)).toMatchObject({ ok: true });
  expect(await message({ type: "PROBE_USB_CONNECTION", token, deviceKey: "phone" }, permissionPage)).toMatchObject({ ok: true });
  expect(await message({ type: "PROBE_USB_CONNECTION", token, deviceKey: "phone" }, permissionPage)).toMatchObject({ ok: false });
  expect(await message({ type: "LOCAL_NETWORK_PROBE_RESULT", token, probeOk: true }, permissionPage)).toMatchObject({ ok: true });
  expect(chrome.tabs.remove).toHaveBeenCalledWith(90);
  expect(chrome.windows.remove).not.toHaveBeenCalled();
  const otherTab = { id: "test", frameId: 0, tab: { id: 8, url: "https://example.org" }, url: "https://example.org" };
  expect(await message({ type: "PAIR", host: "", port: 0, pairCode: "123456" }, otherTab)).toMatchObject({ ok: false });
  expect(await message({ type: "PAIR", host: "", port: 0, pairCode: "123456" })).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(session.wifiRelayRuntimeV2.connection).toBe("online"));
  await message({ type: "UNPAIR" });
});
