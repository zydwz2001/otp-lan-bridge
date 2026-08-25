import { expect, it, vi } from "vitest";

it("shares the last panel position across websites and migrates old per-site positions", async () => {
  type RuntimeListener = (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: Record<string, unknown>) => void
  ) => boolean;

  let runtimeListener: RuntimeListener | undefined;
  const localData: Record<string, unknown> = {
    wifiRelayConfigV2: {
      clientId: "browser-client-id",
      phoneNumber: "",
      host: "",
      port: 0,
      allowedDomains: [],
      excludedDomains: [],
      soundEnabled: true,
      panelPositions: {
        "https://first.example": { x: 40, y: 80, collapsed: false },
        "https://second.example": { x: 160, y: 240, collapsed: true }
      }
    }
  };
  const localSet = vi.fn(async (items: Record<string, unknown>) => { Object.assign(localData, items); });
  const event = { addListener: vi.fn() };

  vi.stubGlobal("chrome", {
    runtime: {
      onInstalled: event,
      onStartup: event,
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener) => { runtimeListener = listener; })
      }
    },
    alarms: { create: vi.fn(), get: vi.fn(async () => undefined), clear: vi.fn(async () => true), onAlarm: event },
    tabs: { onRemoved: event, onUpdated: event, onActivated: event },
    windows: { onRemoved: event, onFocusChanged: event },
    storage: {
      local: {
        get: vi.fn(async () => localData),
        set: localSet
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined)
      }
    }
  } as unknown as typeof chrome);

  await import("../src/background");

  const send = (message: Record<string, unknown>, url: string): Promise<Record<string, unknown>> => (
    new Promise((resolve) => {
      expect(runtimeListener).toBeTypeOf("function");
      const sender = { url, frameId: 0, tab: { id: 1, url } } as chrome.runtime.MessageSender;
      expect(runtimeListener!(message, sender, resolve)).toBe(true);
    })
  );

  const migrated = await send({ type: "GET_CONTENT_INIT", policyUrl: "https://third.example/login" }, "https://third.example/login");
  expect(migrated.position).toEqual({ x: 160, y: 240, collapsed: true });

  await send({
    type: "SET_PANEL_POSITION",
    position: { x: 64.4, y: 300.6, collapsed: false }
  }, "https://first.example/login");

  const nextPage = await send({ type: "GET_CONTENT_INIT", policyUrl: "https://another.example/login" }, "https://another.example/login");
  expect(nextPage.position).toEqual({ x: 64, y: 301, collapsed: false });
  expect(localData.wifiRelayConfigV2).toEqual(expect.objectContaining({
    panelPosition: { x: 64, y: 301, collapsed: false }
  }));
  expect(localData.wifiRelayConfigV2).not.toHaveProperty("panelPositions");
  expect(localSet).toHaveBeenCalled();
});
