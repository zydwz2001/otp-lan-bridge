import { afterEach, expect, it, vi } from "vitest";
import { bytesToBase64, deriveSessionKey, encryptEnvelope, hmac } from "../src/crypto";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("recovers a paired phone on a different Wi-Fi subnet and saves its authenticated address", async () => {
  const deviceId = "ca8f82b4-12b4-4dc8-954f-52b50db52ea1";
  const clientId = "browser-client-id";
  const pairingKey = new Uint8Array(32).fill(7);
  const localData: Record<string, unknown> = {
    wifiRelayConfigV2: {
      phoneNumber: "",
      host: "192.168.18.51",
      port: 42871,
      clientId,
      deviceId,
      pairingKey: bytesToBase64(pairingKey),
      allowedDomains: [],
      excludedDomains: [],
      soundEnabled: true
    }
  };
  const localSet = vi.fn(async (items: Record<string, unknown>) => { Object.assign(localData, items); });
  const sendMessage = vi.fn(async () => undefined);
  let sessionCounter = 0;

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    private sessionKey?: Uint8Array;
    private sessionId = "";
    private statusSent = false;

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
      if (url.includes("otp-ca8f82b412b44dc8.local")) {
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.({} as Event);
        });
      }
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (message.type === "AUTH_INIT") {
        const clientNonce = String(message.clientNonce);
        const serverNonce = bytesToBase64(new Uint8Array(16).fill(++sessionCounter));
        this.sessionId = `session-${sessionCounter}`;
        const transcript = `${deviceId}|${clientId}|${this.sessionId}|${clientNonce}|${serverNonce}`;
        void Promise.all([
          hmac(pairingKey, transcript),
          deriveSessionKey(pairingKey, clientNonce, serverNonce, this.sessionId)
        ]).then(([proof, sessionKey]) => {
          this.sessionKey = sessionKey;
          this.onmessage?.({ data: JSON.stringify({
            v: 1,
            type: "AUTH_CHALLENGE",
            deviceId,
            sessionId: this.sessionId,
            serverNonce,
            proof: bytesToBase64(proof)
          }) } as MessageEvent);
        });
        return;
      }

      if (!message.ciphertext || !this.sessionKey || this.statusSent) return;
      this.statusSent = true;
      void encryptEnvelope("ACK", deviceId, this.sessionId, 1, Date.now(), {
        kind: "STATUS",
        notificationAccess: true,
        hostAddress: "192.168.31.86"
      }, this.sessionKey).then((status) => {
        this.onmessage?.({ data: JSON.stringify(status) } as MessageEvent);
      });
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const event = { addListener: vi.fn() };
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("chrome", {
    runtime: { id: "test-extension-id", onInstalled: event, onStartup: event, onMessage: event },
    alarms: {
      create: vi.fn(),
      get: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      onAlarm: event
    },
    tabs: {
      onRemoved: event,
      onUpdated: event,
      onActivated: event,
      query: vi.fn(async () => [{ id: 7 }]),
      sendMessage
    },
    windows: { onRemoved: event, onFocusChanged: event },
    webNavigation: { getAllFrames: vi.fn(async () => []) },
    storage: {
      local: { get: vi.fn(async () => localData), set: localSet },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) }
    }
  } as unknown as typeof chrome);

  await import("../src/background");
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

  const initialTimeout = timeoutSpy.mock.calls.find(([, delay]) => delay === 8_000)?.[0];
  expect(initialTimeout).toBeTypeOf("function");
  (initialTimeout as () => void)();

  await vi.waitFor(() => {
    const stored = localData.wifiRelayConfigV2 as Record<string, unknown>;
    expect(stored.host).toBe("192.168.31.86");
  });
  expect(FakeWebSocket.instances.filter((instance) => instance.url.includes(".local"))).toHaveLength(2);
  expect(localSet).toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    7,
    expect.objectContaining({ address: { host: "192.168.31.86", port: 42871 } }),
    { frameId: 0 }
  );
});
