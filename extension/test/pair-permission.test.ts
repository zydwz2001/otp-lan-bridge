import { expect, it, vi } from "vitest";

it("does not probe the local network without a one-time background permit", async () => {
  const sendMessage = vi.fn(async () => ({ ok: false, error: "本地网络授权已失效" }));
  const webSocket = vi.fn();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  vi.stubGlobal("WebSocket", webSocket);

  await import("../src/pair-permission");
  const token = "01234567-89ab-4cde-8fab-0123456789ab";
  window.dispatchEvent(new MessageEvent("message", {
    source: window.parent,
    data: { type: "OTP_LOCAL_NETWORK_PROBE", token, host: "192.168.18.52", port: 42871 }
  }));

  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
    type: "CLAIM_LOCAL_NETWORK_PROBE",
    token,
    host: "192.168.18.52",
    port: 42871
  }));
  expect(webSocket).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false, token }), "*");
});
