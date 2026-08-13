import {
  base64ToBytes,
  bytesToBase64,
  decryptEnvelope,
  derivePairingKey,
  deriveSessionKey,
  encryptEnvelope,
  exportPublicKey,
  generatePairingKeyPair,
  randomBase64,
  verifyHmac
} from "./crypto";
import {
  DEFAULT_CONFIG,
  DEFAULT_RUNTIME_STATE,
  type ArmPayload,
  type BridgeRuntimeState,
  type Envelope,
  type ExtensionConfig,
  type FocusTarget,
  type PanelPosition,
  type PanelState
} from "./types";

const CONFIG_KEY = "wifiRelayConfigV2";
const STATE_KEY = "wifiRelayRuntimeV2";
const EXPIRY_ALARM = "wifi-relay-state-expiry";
const ARM_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;
const LOCAL_NETWORK_PROBE_TTL_MS = 45 * 1000;

interface LocalNetworkProbePermit {
  host: string;
  port: number;
  tabId: number;
  expiresAt: number;
}

let config: ExtensionConfig = { ...DEFAULT_CONFIG };
let state: BridgeRuntimeState = { ...DEFAULT_RUNTIME_STATE };
let socket: WebSocket | null = null;
let socketGeneration = 0;
let sessionKey: Uint8Array | null = null;
let sessionId = "";
let incomingSeq = 0;
let outgoingSeq = 0;
let clientNonce = "";
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let sendQueue: Promise<void> = Promise.resolve();
const focusedTargets = new Map<number, FocusTarget>();
const localNetworkProbePermits = new Map<string, LocalNetworkProbePermit>();
let initialization: Promise<void> | null = null;

void ensureInitialized();

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(EXPIRY_ALARM, { periodInMinutes: 0.5 });
  void ensureInitialized();
});
chrome.runtime.onStartup.addListener(() => { void ensureInitialized(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXPIRY_ALARM) void runMaintenance();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  focusedTargets.delete(tabId);
  for (const [token, permit] of localNetworkProbePermits) {
    if (permit.tabId === tabId) localNetworkProbePermits.delete(token);
  }
  if (state.armedTabId === tabId) void cancelWait("标签页已关闭");
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") focusedTargets.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, sendResponse) => {
  void ensureInitialized()
    .then(() => handleMessage(message, sender))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error: unknown) => sendResponse({ ok: false, error: safeError(error) }));
  return true;
});

function ensureInitialized(): Promise<void> {
  if (!initialization) initialization = initialize();
  return initialization;
}

async function initialize(): Promise<void> {
  await loadConfig();
  const stored = await chrome.storage.session.get(STATE_KEY);
  state = { ...DEFAULT_RUNTIME_STATE, ...(stored[STATE_KEY] as Partial<BridgeRuntimeState> | undefined) };
  state.connection = config.pairingKey ? "offline" : "unpaired";
  await evaluateExpiry(false);
  chrome.alarms.create(EXPIRY_ALARM, { periodInMinutes: 0.5 });
  if (config.pairingKey) connectBridge();
}

async function runMaintenance(): Promise<void> {
  await ensureInitialized();
  await evaluateExpiry();
  ensureBridgeConnection();
}

function ensureBridgeConnection(): void {
  if (!config.pairingKey || !config.deviceId || !config.host) return;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  connectBridge();
}

async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  config = normalizeConfig(stored[CONFIG_KEY] as Partial<ExtensionConfig> | undefined);
  if (!config.clientId) {
    config.clientId = crypto.randomUUID();
    await saveConfig();
  }
}

function normalizeConfig(value?: Partial<ExtensionConfig>): ExtensionConfig {
  return {
    ...DEFAULT_CONFIG,
    ...value,
    port: Number.isInteger(value?.port) ? value!.port! : DEFAULT_CONFIG.port,
    allowedDomains: normalizeDomains(value?.allowedDomains ?? []),
    excludedDomains: normalizeDomains(value?.excludedDomains ?? []),
    panelPositions: value?.panelPositions && typeof value.panelPositions === "object" ? value.panelPositions : {}
  };
}

async function saveConfig(): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: serializable(config) });
}

async function persistState(): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: serializable(state) });
}

async function updateState(patch: Partial<BridgeRuntimeState>, broadcast = true): Promise<void> {
  state = { ...state, ...patch };
  await persistState();
  if (broadcast) await broadcastState();
}

async function handleMessage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  const type = String(message.type ?? "");
  switch (type) {
    case "GET_CONTENT_INIT": {
      const url = policyUrl(sender.url ?? "", message.policyUrl);
      const allowed = isUrlAllowed(url);
      const origin = safeOrigin(url);
      const tabId = sender.tab?.id;
      return {
        allowed,
        position: origin ? config.panelPositions[origin] : undefined,
        state: sender.frameId === 0 && tabId !== undefined ? panelStateForTab(tabId) : undefined,
        soundEnabled: config.soundEnabled
      };
    }
    case "TARGET_FOCUSED": {
      const tabId = sender.tab?.id;
      const targetPolicyUrl = policyUrl(sender.url ?? "", message.policyUrl);
      if (tabId === undefined || sender.frameId === undefined || !isUrlAllowed(targetPolicyUrl)) return {};
      const kind = message.kind === "phone" || message.kind === "otp" ? message.kind : "generic";
      focusedTargets.set(tabId, {
        tabId,
        frameId: sender.frameId,
        documentId: sender.documentId,
        kind,
        url: targetPolicyUrl
      });
      return {};
    }
    case "UI_FILL_PHONE": {
      const tabId = requireTab(sender);
      if (!/^\+?\d{6,15}$/.test(config.phoneNumber)) throw new Error("请先在扩展设置中配置手机号");
      await fillFocusedTarget(tabId, config.phoneNumber, "phone");
      await beginWait(tabId, sender.tab?.url ?? "");
      return {};
    }
    case "UI_REARM": {
      await beginWait(requireTab(sender), sender.tab?.url ?? "");
      return {};
    }
    case "UI_FILL_OTP": {
      const tabId = requireTab(sender);
      await evaluateExpiry(false);
      if (state.armedTabId !== tabId || state.waitState !== "CODE_READY" || !state.code || !state.codeExpiresAt || state.codeExpiresAt <= Date.now()) {
        throw new Error("验证码已失效，请重新发送");
      }
      await fillFocusedTarget(tabId, state.code, "otp");
      await sendCancelIfPossible();
      await clearWait("IDLE");
      return {};
    }
    case "UI_SELECT_CANDIDATE": {
      const tabId = requireTab(sender);
      const candidate = String(message.code ?? "");
      if (state.armedTabId !== tabId || !state.candidates?.includes(candidate)) throw new Error("候选验证码已失效");
      await updateState({ code: candidate, candidates: undefined, error: undefined });
      return {};
    }
    case "UI_CANCEL_WAIT":
    case "UI_DISCARD": {
      await cancelWait("等待已取消");
      return {};
    }
    case "UI_GET_CODE": {
      const tabId = requireTab(sender);
      if (state.armedTabId !== tabId || state.waitState !== "CODE_READY" || !state.code) throw new Error("没有可复制的验证码");
      return { code: state.code };
    }
    case "HIDE_SITE": {
      const hostname = hostnameFromUrl(sender.url ?? sender.tab?.url ?? "");
      if (!hostname) throw new Error("无法识别当前站点");
      config.excludedDomains = normalizeDomains([...config.excludedDomains, hostname]);
      await saveConfig();
      if (state.armedTabId === sender.tab?.id) await cancelWait("当前网站已排除");
      return {};
    }
    case "SET_PANEL_POSITION": {
      const origin = safeOrigin(sender.url ?? sender.tab?.url ?? "");
      const position = message.position as Partial<PanelPosition> | undefined;
      if (!origin || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return {};
      config.panelPositions[origin] = {
        x: Math.round(Number(position.x)),
        y: Math.round(Number(position.y)),
        collapsed: Boolean(position.collapsed)
      };
      await saveConfig();
      return {};
    }
    case "GET_OPTIONS":
      return { config: publicConfig(), state: panelStateForTab(-1) };
    case "INLINE_SAVE_PHONE": {
      const phoneNumber = String(message.phoneNumber ?? "").replace(/[\s-]/g, "");
      if (phoneNumber && !/^\+?\d{6,15}$/.test(phoneNumber)) throw new Error("手机号格式无效");
      config.phoneNumber = phoneNumber;
      await saveConfig();
      await broadcastState();
      return { config: publicConfig() };
    }
    case "INLINE_SAVE_ADDRESS": {
      const host = String(message.host ?? "").trim();
      const port = Number(message.port);
      validateHostAndPort(host, port);
      const addressChanged = host !== config.host || port !== config.port;
      config.host = host;
      config.port = port;
      await saveConfig();
      if (addressChanged && config.pairingKey) connectBridge();
      await broadcastState();
      return { config: publicConfig() };
    }
    case "AUTHORIZE_LOCAL_NETWORK_PROBE": {
      const tabId = requireTab(sender);
      if (sender.frameId !== 0) throw new Error("只允许从验证码传递主面板请求本地网络权限");
      const token = String(message.token ?? "");
      const host = String(message.host ?? "").trim();
      const port = Number(message.port);
      if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("本地网络授权票据无效");
      validateHostAndPort(host, port);
      pruneLocalNetworkProbePermits();
      localNetworkProbePermits.set(token, { host, port, tabId, expiresAt: Date.now() + LOCAL_NETWORK_PROBE_TTL_MS });
      return {};
    }
    case "CLAIM_LOCAL_NETWORK_PROBE": {
      const senderUrl = sender.url?.replace(/[?#].*$/, "");
      if (sender.id !== chrome.runtime.id || senderUrl !== chrome.runtime.getURL("pair-permission.html")) {
        throw new Error("本地网络权限页来源无效");
      }
      const token = String(message.token ?? "");
      const permit = localNetworkProbePermits.get(token);
      localNetworkProbePermits.delete(token);
      if (!permit || permit.expiresAt < Date.now() || sender.tab?.id !== permit.tabId) {
        throw new Error("本地网络授权已失效，请重新点击配对");
      }
      if (String(message.host ?? "").trim() !== permit.host || Number(message.port) !== permit.port) {
        throw new Error("本地网络授权地址不匹配");
      }
      return {};
    }
    case "SAVE_OPTIONS": {
      const incoming = message.config as Partial<ExtensionConfig> | undefined;
      if (!incoming) throw new Error("设置内容无效");
      const host = String(incoming.host ?? "").trim();
      const port = Number(incoming.port);
      validateHostAndPort(host, port);
      const phoneNumber = String(incoming.phoneNumber ?? "").replace(/[\s-]/g, "");
      if (phoneNumber && !/^\+?\d{6,15}$/.test(phoneNumber)) throw new Error("手机号格式无效");
      const addressChanged = host !== config.host || port !== config.port;
      config = {
        ...config,
        host,
        port,
        phoneNumber,
        allowedDomains: normalizeDomains(incoming.allowedDomains ?? []),
        excludedDomains: normalizeDomains(incoming.excludedDomains ?? []),
        soundEnabled: incoming.soundEnabled !== false
      };
      await saveConfig();
      if (addressChanged && config.pairingKey) connectBridge();
      await notifyDisabledTabs();
      await broadcastState();
      return {};
    }
    case "PAIR": {
      const host = String(message.host ?? "").trim();
      const port = Number(message.port);
      const pairCode = String(message.pairCode ?? "").trim();
      validateHostAndPort(host, port);
      if (!/^\d{6}$/.test(pairCode)) throw new Error("请输入手机上显示的 6 位配对码");
      if (config.pairingKey) throw new Error("请先解除现有配对");
      await pairDevice(host, port, pairCode);
      return { config: publicConfig() };
    }
    case "STORE_PAIRING": {
      const senderUrl = sender.url?.replace(/[?#].*$/, "");
      if (sender.id !== chrome.runtime.id || senderUrl !== chrome.runtime.getURL("options.html")) {
        throw new Error("只允许从扩展设置页完成配对");
      }
      if (config.pairingKey) throw new Error("请先解除现有配对");
      const host = String(message.host ?? "").trim();
      const port = Number(message.port);
      const deviceId = String(message.deviceId ?? "");
      const pairingKey = String(message.pairingKey ?? "");
      validateHostAndPort(host, port);
      if (deviceId.length < 16 || base64ToBytes(pairingKey).length !== 32) throw new Error("配对结果无效");
      config.host = host;
      config.port = port;
      config.deviceId = deviceId;
      config.pairingKey = pairingKey;
      await saveConfig();
      await updateState({ connection: "offline", error: undefined });
      connectBridge();
      return { config: publicConfig() };
    }
    case "UNPAIR": {
      disconnectBridge(true);
      config.host = "";
      config.port = 0;
      config.deviceId = undefined;
      config.pairingKey = undefined;
      await saveConfig();
      await clearWait("IDLE");
      await updateState({ connection: "unpaired", notificationAccess: undefined });
      return {};
    }
    case "RECONNECT":
      connectBridge();
      return {};
    default:
      throw new Error("不支持的扩展消息");
  }
}

async function pairDevice(host: string, port: number, pairCode: string): Promise<void> {
  const keyPair = await generatePairingKeyPair();
  const clientPublicKey = await exportPublicKey(keyPair.publicKey);
  const url = bridgeUrl(host, port);

  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const pairSocket = new WebSocket(url);
    const timeout = setTimeout(() => {
      pairSocket.close();
      reject(new Error("配对超时，请确认手机与电脑处于同一 Wi-Fi"));
    }, 12_000);
    pairSocket.onopen = () => {
      pairSocket.send(JSON.stringify({ v: 1, type: "PAIR_INIT", clientId: config.clientId, pairCode, clientPublicKey }));
    };
    pairSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (data.type === "ERROR") throw new Error(String(data.message ?? "配对失败"));
        if (data.type !== "PAIR_OK") return;
        clearTimeout(timeout);
        resolve(data);
        pairSocket.close(1000, "complete");
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        pairSocket.close();
      }
    };
    pairSocket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("无法连接手机，请检查 IP、端口和同一 Wi-Fi"));
    };
  });

  const deviceId = String(response.deviceId ?? "");
  const serverPublicKey = String(response.serverPublicKey ?? "");
  const proof = String(response.proof ?? "");
  if (!deviceId || !serverPublicKey || !proof) throw new Error("手机返回的配对响应不完整");
  const pairingKey = await derivePairingKey(keyPair.privateKey, serverPublicKey, pairCode);
  const transcript = `${clientPublicKey}|${serverPublicKey}|${deviceId}|${config.clientId}`;
  if (!(await verifyHmac(pairingKey, transcript, proof))) throw new Error("配对指纹验证失败");

  config.host = host;
  config.port = port;
  config.deviceId = deviceId;
  config.pairingKey = bytesToBase64(pairingKey);
  await saveConfig();
  await updateState({ connection: "offline", error: undefined });
  connectBridge();
}

function connectBridge(): void {
  disconnectBridge(false);
  if (!config.pairingKey || !config.deviceId || !config.host) {
    void updateState({ connection: "unpaired" });
    return;
  }

  const generation = ++socketGeneration;
  void updateState({ connection: "connecting", error: undefined });
  try {
    socket = new WebSocket(bridgeUrl(config.host, config.port));
  } catch {
    handleDisconnect(generation, "手机地址无效");
    return;
  }

  socket.onopen = () => {
    if (generation !== socketGeneration || !socket) return;
    clientNonce = randomBase64(16);
    socket.send(JSON.stringify({
      v: 1,
      type: "AUTH_INIT",
      deviceId: config.deviceId,
      clientId: config.clientId,
      clientNonce,
      timestamp: Date.now()
    }));
  };
  socket.onmessage = (event) => {
    if (generation !== socketGeneration) return;
    void handleSocketMessage(String(event.data)).catch((error: unknown) => {
      if (generation === socketGeneration) {
        void updateState({ error: safeError(error) });
        socket?.close(1008, "protocol error");
      }
    });
  };
  socket.onerror = () => { /* onclose owns retry and user-facing state */ };
  socket.onclose = () => handleDisconnect(generation, "手机未连接，请检查手机端是否已经开始传递");
}

function disconnectBridge(incrementGeneration = true): void {
  if (incrementGeneration) socketGeneration += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  reconnectTimer = undefined;
  heartbeatTimer = undefined;
  const current = socket;
  socket = null;
  current?.close(1000, "reconnect");
  sessionKey = null;
  sessionId = "";
  incomingSeq = 0;
  outgoingSeq = 0;
  sendQueue = Promise.resolve();
}

function handleDisconnect(generation: number, message: string): void {
  if (generation !== socketGeneration) return;
  socket = null;
  sessionKey = null;
  sessionId = "";
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  const waitState = state.waitState === "ARMED" ? "ARMED_OFFLINE" : state.waitState;
  void updateState({ connection: config.pairingKey ? "offline" : "unpaired", waitState, error: message });
  if (!config.pairingKey) return;
  reconnectTimer = setTimeout(connectBridge, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

async function handleSocketMessage(raw: string): Promise<void> {
  const message = JSON.parse(raw) as Record<string, unknown>;
  if (!message.ciphertext) {
    await handleHandshakeMessage(message);
    return;
  }
  if (!sessionKey || !sessionId || message.deviceId !== config.deviceId || message.sessionId !== sessionId) {
    throw new Error("收到不属于当前会话的数据");
  }
  const envelope = message as unknown as Envelope;
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= incomingSeq || Math.abs(Date.now() - envelope.timestamp) > CLOCK_TOLERANCE_MS) {
    throw new Error("已拒绝过期或重复消息");
  }
  const payload = await decryptEnvelope(envelope, sessionKey);
  incomingSeq = envelope.seq;
  await handleBusinessMessage(envelope.type, payload);
}

async function handleHandshakeMessage(message: Record<string, unknown>): Promise<void> {
  if (message.type === "ERROR") throw new Error(String(message.message ?? "手机认证失败"));
  if (message.type !== "AUTH_CHALLENGE" || !config.pairingKey || !config.deviceId) return;
  const returnedSessionId = String(message.sessionId ?? "");
  const serverNonce = String(message.serverNonce ?? "");
  const proof = String(message.proof ?? "");
  const pairingKey = base64ToBytes(config.pairingKey);
  const transcript = `${config.deviceId}|${config.clientId}|${returnedSessionId}|${clientNonce}|${serverNonce}`;
  if (!(await verifyHmac(pairingKey, transcript, proof))) throw new Error("手机身份验证失败");

  sessionId = returnedSessionId;
  sessionKey = await deriveSessionKey(pairingKey, clientNonce, serverNonce, sessionId);
  incomingSeq = 0;
  outgoingSeq = 0;
  reconnectDelay = 1_000;
  await sendEncrypted("ACK", { kind: "AUTH_OK" });
  await updateState({
    connection: "online",
    waitState: state.waitState === "ARMED_OFFLINE" ? "ARMED" : state.waitState,
    error: undefined
  });
  heartbeatTimer = setInterval(() => { void sendEncrypted("PING", { at: Date.now() }); }, 20_000);

  if ((state.waitState === "ARMED" || state.waitState === "ARMED_OFFLINE") && validArmFromState()) {
    await sendArmFromState();
  }
}

async function handleBusinessMessage(type: Envelope["type"], payload: Record<string, unknown>): Promise<void> {
  if (type === "PING") {
    await sendEncrypted("PONG", { at: Date.now() });
    return;
  }
  if (type === "PONG") return;
  if (type === "ACK") {
    if (payload.kind === "STATUS") {
      await updateState({ notificationAccess: Boolean(payload.notificationAccess) });
    } else if (payload.kind === "ARMED" && payload.requestId === state.requestId) {
      await updateState({ waitState: "ARMED", error: undefined });
    }
    return;
  }
  if (type === "ERROR") {
    const message = String(payload.message ?? "手机返回错误");
    await updateState({ error: message });
    return;
  }
  if (type !== "OTP") return;

  const now = Date.now();
  if (!state.requestId || payload.requestId !== state.requestId ||
      (state.waitState !== "ARMED" && state.waitState !== "ARMED_OFFLINE") ||
      !state.waitExpiresAt || now > state.waitExpiresAt + CLOCK_TOLERANCE_MS
  ) return;
  const code = typeof payload.code === "string" && /^\d{4,8}$/.test(payload.code) ? payload.code : undefined;
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates.filter((value): value is string => typeof value === "string" && /^\d{4,8}$/.test(value)).slice(0, 5)
    : [];
  if (!code && candidates.length === 0) return;
  const receivedAt = Number(payload.receivedAt);
  const messageId = String(payload.messageId ?? "");
  if (!Number.isFinite(receivedAt) || !messageId) return;

  await updateState({
    waitState: "CODE_READY",
    code,
    candidates: code ? undefined : candidates,
    codeExpiresAt: now + CODE_TTL_MS,
    messageId,
    receivedAt,
    sourceAppLabel: String(payload.sourceAppLabel ?? "短信").slice(0, 40),
    confidence: Number(payload.confidence),
    error: code ? undefined : "识别到多个数字，请确认验证码"
  });
  await sendEncrypted("ACK", { kind: "OTP_RECEIVED", messageId });
  scheduleExactExpiry();
}

function sendEncrypted(type: Envelope["type"], payload: unknown): Promise<void> {
  sendQueue = sendQueue.then(async () => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionKey || !sessionId || !config.deviceId) {
      throw new Error("手机当前离线");
    }
    outgoingSeq += 1;
    const envelope = await encryptEnvelope(type, config.deviceId, sessionId, outgoingSeq, Date.now(), payload, sessionKey);
    socket.send(JSON.stringify(envelope));
  }).catch((error: unknown) => {
    void updateState({ error: safeError(error) });
  });
  return sendQueue;
}

async function beginWait(tabId: number, url: string): Promise<void> {
  const now = Date.now();
  const arm: ArmPayload = {
    requestId: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + ARM_TTL_MS,
    expectedDigits: [4, 5, 6],
    siteLabel: hostnameFromUrl(url).slice(0, 80)
  };
  await updateState({
    waitState: state.connection === "online" ? "ARMED" : "ARMED_OFFLINE",
    requestId: arm.requestId,
    armedTabId: tabId,
    createdAt: arm.createdAt,
    waitExpiresAt: arm.expiresAt,
    code: undefined,
    candidates: undefined,
    codeExpiresAt: undefined,
    messageId: undefined,
    receivedAt: undefined,
    sourceAppLabel: undefined,
    confidence: undefined,
    error: state.connection === "online" ? undefined : "手机当前离线，连接恢复后继续等待"
  });
  if (state.connection === "online") await sendEncrypted("ARM", arm);
  scheduleExactExpiry();
}

async function sendArmFromState(): Promise<void> {
  if (!validArmFromState()) return;
  await sendEncrypted("ARM", {
    requestId: state.requestId,
    createdAt: state.createdAt,
    expiresAt: state.waitExpiresAt,
    expectedDigits: [4, 5, 6],
    siteLabel: "当前网站"
  });
}

function validArmFromState(): boolean {
  return Boolean(state.requestId && state.createdAt && state.waitExpiresAt && state.waitExpiresAt > Date.now());
}

async function fillFocusedTarget(tabId: number, value: string, purpose: "phone" | "otp"): Promise<void> {
  const target = focusedTargets.get(tabId);
  if (!target) throw new Error(purpose === "phone" ? "请先点击手机号输入框" : "请先点击验证码输入框");
  const response = await chrome.tabs.sendMessage(
    tabId,
    { type: "FILL_VALUE", value, purpose },
    { frameId: target.frameId }
  ) as { ok?: boolean; error?: string } | undefined;
  if (!response?.ok) {
    focusedTargets.delete(tabId);
    throw new Error(response?.error ?? "输入框已失效，请重新点击");
  }
}

async function sendCancelIfPossible(): Promise<void> {
  if (state.connection === "online" && state.requestId) await sendEncrypted("CANCEL", { requestId: state.requestId });
}

async function cancelWait(reason: string): Promise<void> {
  await sendCancelIfPossible();
  await clearWait("IDLE", reason);
}

async function clearWait(nextState: "IDLE" | "EXPIRED", error?: string): Promise<void> {
  await updateState({
    waitState: nextState,
    requestId: undefined,
    armedTabId: undefined,
    createdAt: undefined,
    waitExpiresAt: undefined,
    code: undefined,
    candidates: undefined,
    codeExpiresAt: undefined,
    messageId: undefined,
    receivedAt: undefined,
    sourceAppLabel: undefined,
    confidence: undefined,
    error
  });
}

async function evaluateExpiry(broadcast = true): Promise<void> {
  const now = Date.now();
  if (state.waitState === "CODE_READY" && state.codeExpiresAt && state.codeExpiresAt <= now) {
    await clearWait("EXPIRED", "验证码已过期，请重新发送");
  } else if ((state.waitState === "ARMED" || state.waitState === "ARMED_OFFLINE") && state.waitExpiresAt && state.waitExpiresAt <= now) {
    await clearWait("EXPIRED", "等待已超时，请重新等待");
  } else if (broadcast) {
    await broadcastState();
  }
}

function scheduleExactExpiry(): void {
  const expiresAt = state.waitState === "CODE_READY" ? state.codeExpiresAt : state.waitExpiresAt;
  if (!expiresAt) return;
  setTimeout(() => { void evaluateExpiry(); }, Math.max(0, expiresAt - Date.now()) + 50);
}

async function broadcastState(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id !== undefined).map(async (tab) => {
    try {
      await chrome.tabs.sendMessage(tab.id!, { type: "UI_STATE", state: panelStateForTab(tab.id!) }, { frameId: 0 });
    } catch {
      // Restricted pages and tabs without the content script are expected.
    }
  }));
  try { await chrome.runtime.sendMessage({ type: "OPTIONS_STATE", state: panelStateForTab(-1) }); } catch { /* options page is closed */ }
}

async function notifyDisabledTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined || !tab.url || isUrlAllowed(tab.url)) return;
    try { await chrome.tabs.sendMessage(tab.id, { type: "POLICY_DISABLED" }, { frameId: 0 }); } catch { /* restricted tab */ }
  }));
}

function panelStateForTab(tabId: number): PanelState {
  const ownsWait = state.armedTabId === tabId;
  const base: PanelState = { ...state, maskedPhone: maskPhone(config.phoneNumber) };
  delete (base as Partial<BridgeRuntimeState>).armedTabId;
  if (!ownsWait) {
    return {
      connection: state.connection,
      notificationAccess: state.notificationAccess,
      waitState: "IDLE",
      maskedPhone: base.maskedPhone,
      error: state.connection === "offline" ? state.error : undefined
    };
  }
  return base;
}

function publicConfig(): Omit<ExtensionConfig, "pairingKey" | "panelPositions"> & { paired: boolean } {
  const { pairingKey: _key, panelPositions: _positions, ...safe } = config;
  return { ...safe, paired: Boolean(config.pairingKey && config.deviceId) };
}

function requireTab(sender: chrome.runtime.MessageSender): number {
  const tabId = sender.tab?.id;
  if (tabId === undefined) throw new Error("当前页面不可用");
  return tabId;
}

function pruneLocalNetworkProbePermits(): void {
  const now = Date.now();
  for (const [token, permit] of localNetworkProbePermits) {
    if (permit.expiresAt < now) localNetworkProbePermits.delete(token);
  }
}

function validateHostAndPort(host: string, port: number): void {
  if (!isPrivateWifiIpv4(host)) throw new Error("请输入 App 显示的 Wi-Fi 地址，例如 192.168.1.23");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口必须在 1024–65535 之间");
}

function isPrivateWifiIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function bridgeUrl(host: string, port: number): string {
  validateHostAndPort(host, port);
  return `ws://${host}:${port}/v1/bridge`;
}

function normalizeDomains(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "").filter(Boolean))].sort();
}

function isUrlAllowed(url: string): boolean {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return false;
  if (config.excludedDomains.some((domain) => domainMatches(hostname, domain))) return false;
  return config.allowedDomains.length === 0 || config.allowedDomains.some((domain) => domainMatches(hostname, domain));
}

function domainMatches(hostname: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\*\./, "");
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function hostnameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname) return parsed.hostname.toLowerCase();
    if (parsed.origin && parsed.origin !== "null") return new URL(parsed.origin).hostname.toLowerCase();
    return "";
  } catch { return ""; }
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

function policyUrl(senderUrl: string, fallback: unknown): string {
  if (/^https?:/i.test(senderUrl)) return senderUrl;
  const fallbackUrl = typeof fallback === "string" ? fallback : "";
  return /^https?:/i.test(fallbackUrl) ? fallbackUrl : senderUrl;
}

function maskPhone(phone: string): string {
  if (phone.length < 7) return phone ? "***" : "未配置";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : "操作失败";
}

function serializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
