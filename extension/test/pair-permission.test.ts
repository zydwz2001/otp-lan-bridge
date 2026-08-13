import { expect, it, vi } from "vitest";

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
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "LOCAL_NETWORK_PROBE_RESULT",
    token,
    probeOk: false
  }));
});
