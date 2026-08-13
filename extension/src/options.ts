import type { BridgeRuntimeState, ExtensionConfig } from "./types";
import {
  bytesToBase64,
  derivePairingKey,
  exportPublicKey,
  generatePairingKeyPair,
  verifyHmac
} from "./crypto";

const hostInput = input("host");
const portInput = input("port");
const pairCodeInput = input("pair-code");
const phoneInput = input("phone");
const soundInput = input("sound");
const allowedInput = textarea("allowed");
const excludedInput = textarea("excluded");
const statusDot = element("status-dot");
const connectionStatus = element("connection-status");
const notificationStatus = element("notification-status");
const feedback = element("feedback");
const pairFeedback = element("pair-feedback");
const pairButton = button("pair");
const reconnectButton = button("reconnect");
const unpairButton = button("unpair");
const saveButton = button("save");

let paired = false;
let clientId = "";

void load();

pairButton.addEventListener("click", () => runBusy(pairButton, async () => {
  showPairFeedback("正在检查 Wi-Fi 地址…");
  await save(false);
  const host = hostInput.value.trim();
  const port = Number(portInput.value);
  const pairCode = pairCodeInput.value.trim();
  showPairFeedback(`正在连接 ${host}:${port}，请保持手机 App 在前台…`);
  const result = await pairFromVisiblePage(host, port, pairCode);
  const response = await send({ type: "STORE_PAIRING", host, port, ...result });
  if (!response.ok) throw new Error(String(response.error));
  pairCodeInput.value = "";
  paired = true;
  renderButtons();
  showPairFeedback("配对成功，正在建立加密连接", false, true);
  showFeedback("配对成功，正在连接手机");
}));

reconnectButton.addEventListener("click", () => runBusy(reconnectButton, async () => {
  const response = await send({ type: "RECONNECT" });
  if (!response.ok) throw new Error(String(response.error));
  showFeedback("正在重新连接");
}));

unpairButton.addEventListener("click", () => runBusy(unpairButton, async () => {
  if (!confirm("确定解除当前手机配对？之后需要重新输入手机上的临时配对码。")) return;
  const response = await send({ type: "UNPAIR" });
  if (!response.ok) throw new Error(String(response.error));
  paired = false;
  renderButtons();
  showFeedback("已解除配对");
}));

saveButton.addEventListener("click", () => runBusy(saveButton, () => save(true)));

chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
  if (message.type === "OPTIONS_STATE") renderState(message.state as BridgeRuntimeState);
});

async function load(): Promise<void> {
  const response = await send({ type: "GET_OPTIONS" });
  if (!response.ok) {
    showFeedback(String(response.error), true);
    return;
  }
  const config = response.config as (Omit<ExtensionConfig, "pairingKey" | "panelPositions"> & { paired: boolean });
  hostInput.value = config.host ?? "";
  portInput.value = config.port >= 1024 ? String(config.port) : "";
  phoneInput.value = config.phoneNumber ?? "";
  soundInput.checked = config.soundEnabled !== false;
  allowedInput.value = (config.allowedDomains ?? []).join("\n");
  excludedInput.value = (config.excludedDomains ?? []).join("\n");
  paired = config.paired;
  clientId = config.clientId;
  renderButtons();
  renderState(response.state as BridgeRuntimeState);
}

async function save(showSuccess: boolean): Promise<void> {
  const response = await send({
    type: "SAVE_OPTIONS",
    config: {
      host: hostInput.value.trim(),
      port: Number(portInput.value),
      phoneNumber: phoneInput.value.trim(),
      soundEnabled: soundInput.checked,
      allowedDomains: lines(allowedInput.value),
      excludedDomains: lines(excludedInput.value)
    }
  });
  if (!response.ok) throw new Error(String(response.error));
  if (showSuccess) showFeedback("设置已保存");
}

function renderState(state: BridgeRuntimeState): void {
  statusDot.className = `status-dot ${state.connection}`;
  connectionStatus.textContent = ({
    unpaired: "尚未配对",
    connecting: "正在连接手机",
    online: "手机已连接",
    offline: "手机离线"
  })[state.connection];
  notificationStatus.textContent = state.connection === "online"
    ? state.notificationAccess === false ? "手机通知权限异常" : "端到端连接正常"
    : state.error ?? "";
}

function renderButtons(): void {
  pairButton.disabled = paired;
  pairCodeInput.disabled = paired;
  unpairButton.disabled = !paired;
  reconnectButton.disabled = !paired;
}

async function runBusy(target: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  const originalLabel = target.textContent;
  target.disabled = true;
  if (target === pairButton) target.textContent = "配对中…";
  feedback.textContent = "";
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败";
    showFeedback(message, true);
    if (target === pairButton) showPairFeedback(message, true);
  } finally {
    target.textContent = originalLabel;
    renderButtons();
  }
}

function showFeedback(message: string, error = false): void {
  feedback.textContent = message;
  feedback.style.color = error ? "#b63030" : "#286e3e";
}

function showPairFeedback(message: string, error = false, success = false): void {
  pairFeedback.textContent = message;
  pairFeedback.className = `inline-feedback${error ? " error" : success ? " success" : ""}`;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await chrome.runtime.sendMessage(message) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "扩展后台未响应" };
  }
}

async function pairFromVisiblePage(host: string, port: number, pairCode: string): Promise<{ deviceId: string; pairingKey: string }> {
  if (!/^\d{6}$/.test(pairCode)) throw new Error("请输入手机上显示的 6 位配对码");
  if (!clientId) throw new Error("扩展设备 ID 尚未就绪，请刷新页面");
  const keyPair = await generatePairingKeyPair();
  const clientPublicKey = await exportPublicKey(keyPair.publicKey);
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${port}/v1/bridge`);
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("手机服务未响应：请在 App 中先停止传递，再重新开始传递后重试"));
    }, 12_000);
    socket.onopen = () => socket.send(JSON.stringify({
      v: 1,
      type: "PAIR_INIT",
      clientId,
      pairCode,
      clientPublicKey
    }));
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (data.type === "ERROR") throw new Error(String(data.message ?? "配对失败"));
        if (data.type !== "PAIR_OK") return;
        window.clearTimeout(timeout);
        resolve(data);
        socket.close(1000, "complete");
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
        socket.close();
      }
    };
    socket.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("无法连接手机；请检查 Wi-Fi 地址，并在 Chrome 提示时允许本地网络访问"));
    };
  });
  const deviceId = String(response.deviceId ?? "");
  const serverPublicKey = String(response.serverPublicKey ?? "");
  const proof = String(response.proof ?? "");
  if (!deviceId || !serverPublicKey || !proof) throw new Error("手机返回的配对响应不完整");
  const key = await derivePairingKey(keyPair.privateKey, serverPublicKey, pairCode);
  const transcript = `${clientPublicKey}|${serverPublicKey}|${deviceId}|${clientId}`;
  if (!(await verifyHmac(key, transcript, proof))) throw new Error("配对指纹验证失败");
  return { deviceId, pairingKey: bytesToBase64(key) };
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value;
}

function input(id: string): HTMLInputElement {
  const value = element(id);
  if (!(value instanceof HTMLInputElement)) throw new Error(`Expected input: ${id}`);
  return value;
}

function textarea(id: string): HTMLTextAreaElement {
  const value = element(id);
  if (!(value instanceof HTMLTextAreaElement)) throw new Error(`Expected textarea: ${id}`);
  return value;
}

function button(id: string): HTMLButtonElement {
  const value = element(id);
  if (!(value instanceof HTMLButtonElement)) throw new Error(`Expected button: ${id}`);
  return value;
}
