export {};

interface ProbeRequest {
  type: "OTP_LOCAL_NETWORK_PROBE";
  token: string;
  host: string;
  port: number;
}

const status = document.getElementById("status");
let activeSocket: WebSocket | null = null;

window.addEventListener("message", async (event: MessageEvent<Partial<ProbeRequest>>) => {
  if (event.source !== window.parent || event.data?.type !== "OTP_LOCAL_NETWORK_PROBE") return;
  const token = String(event.data.token ?? "");
  const host = String(event.data.host ?? "").trim();
  const port = Number(event.data.port);
  if (!token || !isPrivateIpv4(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    respond(token, false, "手机地址或端口无效");
    return;
  }

  const claim = await chrome.runtime.sendMessage({ type: "CLAIM_LOCAL_NETWORK_PROBE", token, host, port }) as Record<string, unknown> | undefined;
  if (!claim?.ok) {
    respond(token, false, String(claim?.error ?? "本地网络授权已失效，请重新点击配对"));
    return;
  }

  activeSocket?.close();
  if (status) status.textContent = "请在浏览器弹窗中点击“允许”…";
  const socket = new WebSocket(`ws://${host}:${port}/v1/bridge`);
  activeSocket = socket;
  const timeout = window.setTimeout(() => {
    socket.close();
    respond(token, false, "等待本地网络权限超时，请重新点击配对");
  }, 30_000);
  socket.onopen = () => {
    window.clearTimeout(timeout);
    socket.close(1000, "permission granted");
    activeSocket = null;
    respond(token, true);
  };
  socket.onerror = () => {
    window.clearTimeout(timeout);
    activeSocket = null;
    respond(token, false, "浏览器未允许访问手机，请重新配对并点击“允许”");
  };
}, { passive: true });

function respond(token: string, ok: boolean, error?: string): void {
  window.parent.postMessage({ type: "OTP_LOCAL_NETWORK_PROBE_RESULT", token, ok, error }, "*");
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}
