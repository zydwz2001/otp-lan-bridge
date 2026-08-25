import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("recovers stalled authentication and a dormant reconnect loop", async () => {
  type AlarmListener = (alarm: chrome.alarms.Alarm) => void;
  let alarmListener: AlarmListener | undefined;
  let activatedListener: (() => void) | undefined;

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

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    send(): void {}

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const event = { addListener: vi.fn() };
  const alarmCreate = vi.fn();
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension-id",
      onInstalled: event,
      onStartup: event,
      onMessage: event,
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`
    },
    alarms: {
      create: alarmCreate,
      get: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      onAlarm: {
        addListener: vi.fn((listener: AlarmListener) => { alarmListener = listener; })
      }
    },
    tabs: {
      onRemoved: event,
      onUpdated: event,
      onActivated: {
        addListener: vi.fn((listener: () => void) => { activatedListener = listener; })
      },
      query: vi.fn(async () => []),
      sendMessage: vi.fn()
    },
    windows: {
      onRemoved: event,
      onFocusChanged: event,
      create: vi.fn(),
      remove: vi.fn()
    },
    webNavigation: { getAllFrames: vi.fn(async () => []) },
    storage: {
      local: {
        get: vi.fn(async () => ({
          wifiRelayConfigV2: {
            phoneNumber: "",
            host: "192.168.18.255",
            port: 42871,
            clientId: "browser-client-id",
            deviceId: "phone-device-id",
            pairingKey: "AA==",
            allowedDomains: [],
            excludedDomains: [],
            soundEnabled: true
          }
        })),
        set: vi.fn(async () => undefined)
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined)
      }
    }
  } as unknown as typeof chrome);

  await import("../src/background");
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

  const first = FakeWebSocket.instances[0]!;
  first.readyState = FakeWebSocket.OPEN;
  const authenticationTimeout = timeoutSpy.mock.calls.find(([, delay]) => delay === 8_000)?.[0];
  expect(authenticationTimeout).toBeTypeOf("function");
  (authenticationTimeout as () => void)();
  expect(first.readyState).toBe(FakeWebSocket.CLOSED);
  expect(alarmCreate).toHaveBeenCalledWith("wifi-relay-reconnect", { delayInMinutes: 0.5 });

  expect(alarmListener).toBeTypeOf("function");
  alarmListener!({ name: "wifi-relay-reconnect", scheduledTime: Date.now() });
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));

  const second = FakeWebSocket.instances[1]!;
  second.readyState = FakeWebSocket.CLOSED;
  second.onclose?.({} as CloseEvent);
  expect(activatedListener).toBeTypeOf("function");
  activatedListener!();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
});
