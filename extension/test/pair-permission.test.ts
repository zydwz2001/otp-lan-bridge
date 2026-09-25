import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestUsbDevice } from "../src/usb-bridge";

vi.mock("../src/usb-bridge", () => ({ requestUsbDevice: vi.fn() }));
const token = "01234567-89ab-4cde-8fab-0123456789ab";
beforeEach(() => {
  vi.resetModules();
  vi.mocked(requestUsbDevice).mockReset();
  location.hash = token;
  document.body.innerHTML = '<span id="status"></span><button id="continue">连接手机</button>';
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("does not probe the local network without a one-time background permit", async () => {
  const token = "01234567-89ab-4cde-8fab-0123456789ab";
  location.hash = token;
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === "CLAIM_LOCAL_NETWORK_PROBE") return { ok: false, error: "本地网络授权已失效" };
    return { ok: true };
  });
  const webSocket = vi.fn();
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  vi.stubGlobal("WebSocket", webSocket);
  document.body.innerHTML = '<span id="status"></span><button id="continue">连接手机</button>';

  await import("../src/pair-permission");
  (document.getElementById("continue") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
    type: "CLAIM_LOCAL_NETWORK_PROBE",
    token
  }));
  expect(webSocket).not.toHaveBeenCalled();
  expect(requestUsbDevice).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "LOCAL_NETWORK_PROBE_RESULT",
    token,
    probeOk: false
  }));
});

it("requests USB synchronously on the existing button click even with invalid Wi-Fi fields", async () => {
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === "CLAIM_LOCAL_NETWORK_PROBE") return { ok: true, host: "invalid", port: 0 };
    return { ok: true };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const webSocket = vi.fn();
  vi.stubGlobal("WebSocket", webSocket);
  vi.mocked(requestUsbDevice).mockResolvedValue("phone");
  await import("../src/pair-permission");
  const button = document.getElementById("continue") as HTMLButtonElement;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  button.click();
  // Before any await/microtask: Chrome's transient activation is still available.
  expect(requestUsbDevice).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
    type: "PROBE_USB_CONNECTION", token, deviceKey: "phone"
  }));
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "LOCAL_NETWORK_PROBE_RESULT", probeOk: true }));
  expect(webSocket).not.toHaveBeenCalled();
});

it("continues the existing Wi-Fi permission flow when USB selection is cancelled", async () => {
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === "CLAIM_LOCAL_NETWORK_PROBE") return { ok: true, host: "192.168.1.2", port: 42871 };
    return { ok: true };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const urls: string[] = [];
  class WifiSocket {
    onopen?: () => void;
    close = vi.fn();
    constructor(url: string) { urls.push(url); queueMicrotask(() => this.onopen?.()); }
  }
  vi.stubGlobal("WebSocket", WifiSocket);
  vi.mocked(requestUsbDevice).mockRejectedValue(new DOMException("Cancelled", "NotFoundError"));
  await import("../src/pair-permission");
  const button = document.getElementById("continue") as HTMLButtonElement;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  button.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "LOCAL_NETWORK_PROBE_RESULT", probeOk: true })));
  expect(urls).toEqual(["ws://192.168.1.2:42871/v1/bridge"]);
});

it("reports browser permission failures instead of silently falling back to Wi-Fi", async () => {
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === "CLAIM_LOCAL_NETWORK_PROBE") return { ok: true, host: "192.168.1.2", port: 42871 };
    return { ok: true };
  });
  const webSocket = vi.fn();
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  vi.stubGlobal("WebSocket", webSocket);
  vi.mocked(requestUsbDevice).mockRejectedValue(new DOMException("Blocked", "SecurityError"));
  await import("../src/pair-permission");
  const button = document.getElementById("continue") as HTMLButtonElement;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  button.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "LOCAL_NETWORK_PROBE_RESULT", probeOk: false,
    probeError: "浏览器未允许设备连接，请检查浏览器的设备权限后重试"
  })));
  expect(webSocket).not.toHaveBeenCalled();
});
