import { requestUsbDevice } from "./usb-bridge";

const statusElement = document.getElementById("status");
const continueButton = document.getElementById("continue") as HTMLButtonElement | null;
const token = decodeURIComponent(location.hash.slice(1));
let claim: Record<string, unknown> | undefined;
if (continueButton) continueButton.disabled = true;
// Claim before the click so requestDevice runs within the actual user gesture.
void chrome.runtime.sendMessage({ type: "CLAIM_LOCAL_NETWORK_PROBE", token }).then((result) => {
  claim = result;
  if (!token || !claim?.ok) return finish(false, String(claim?.error ?? "连接授权已失效，请重新配对"));
  if (continueButton) continueButton.disabled = false;
}).catch(() => finish(false, "连接授权已失效，请重新配对"));

continueButton?.addEventListener("click", () => {
  if (!claim?.ok) return;
  continueButton.disabled = true;
  continueButton.textContent = "正在连接…";
  // Only this extension-owned page requests USB access, never a website's content script.
  const selected = requestUsbDevice();
  void selected.catch((error: unknown) => {
    // Only cancellation means "continue over Wi-Fi". Browser permission or
    // policy errors must not be hidden behind a misleading network timeout.
    if (error && typeof error === "object" && "name" in error && error.name === "NotFoundError") return undefined;
    throw new Error("浏览器未允许设备连接，请检查浏览器的设备权限后重试");
  }).then(async (deviceKey) => {
    if (deviceKey) {
      const result = await chrome.runtime.sendMessage({ type: "PROBE_USB_CONNECTION", token, deviceKey });
      await finish(result?.ok === true, result?.error);
    } else {
      await requestPermission();
    }
  }).catch((error: unknown) => finish(false, error instanceof Error ? error.message : "无法连接手机，请确认手机已授权当前电脑且已开始传递"));
}, { once: true });

async function requestPermission(): Promise<void> {
  if (!claim?.ok) return;
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
