export {};

const statusElement = document.getElementById("status");
const continueButton = document.getElementById("continue") as HTMLButtonElement | null;
const token = decodeURIComponent(location.hash.slice(1));
continueButton?.addEventListener("click", () => {
  continueButton.disabled = true;
  continueButton.textContent = "正在连接…";
  void requestPermission();
}, { once: true });

async function requestPermission(): Promise<void> {
  if (!token) return finish(false, "授权请求无效，请关闭窗口后重新配对");
  const claim = await chrome.runtime.sendMessage({ type: "CLAIM_LOCAL_NETWORK_PROBE", token }) as Record<string, unknown> | undefined;
  if (!claim?.ok) {
    return finish(false, String(claim?.error ?? "本地网络授权已失效，请重新点击配对"));
  }
  const host = String(claim.host ?? "").trim();
  const port = Number(claim.port);
  if (!isPrivateIpv4(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return finish(false, "手机地址或端口无效");
  }
  if (statusElement) statusElement.textContent = "正在连接；如出现 Chrome 提示，请点击“允许”";
  const socket = new WebSocket(`ws://${host}:${port}/v1/bridge`);
  const timeout = window.setTimeout(() => {
    socket.close();
    void finish(false, "手机服务未响应。请在手机 App 中停止传递，再重新开始传递后重试。");
  }, 30_000);
  socket.onopen = () => {
    window.clearTimeout(timeout);
    socket.close(1000, "permission granted");
    void finish(true);
  };
  socket.onerror = () => {
    window.clearTimeout(timeout);
    void finish(false, "无法访问手机。请确认同一 Wi-Fi，并在 Chrome 提示中点击“允许”。");
  };
}

async function finish(ok: boolean, error?: string): Promise<void> {
  if (statusElement) {
    statusElement.textContent = ok ? "已允许，正在返回配对页面…" : String(error ?? "授权失败");
    statusElement.classList.toggle("error", !ok);
  }
  if (!ok && continueButton) {
    continueButton.hidden = true;
  }
  await chrome.runtime.sendMessage({
    type: "LOCAL_NETWORK_PROBE_RESULT",
    token,
    probeOk: ok,
    probeError: error
  }).catch(() => undefined);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}
