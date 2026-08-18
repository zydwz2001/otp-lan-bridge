import { classifyTarget, fillTarget, findOtpTarget, isEditableTarget, submitOtpForm, type EditableTarget } from "./fill";
import type { PanelPosition, PanelState } from "./types";

let enabled = false;
let lastTarget: EditableTarget | null = null;
let panel: BridgePanel | null = null;
const policyUrl = effectivePolicyUrl();
const PANEL_WIDTH = 244;
const COLLAPSED_WIDTH = 132;
const DEFAULT_TOP = 8;

interface InlineSettingsConfig {
  clientId: string;
  host: string;
  port: number;
  phoneNumber: string;
  paired: boolean;
}

void initialize();

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  if (message.type === "FILL_VALUE") {
    const purpose = message.purpose === "phone" ? "phone" : "otp";
    const value = String(message.value ?? "");
    const target = purpose === "otp" ? findOtpTarget(document, lastTarget, value) : lastTarget;
    const result = fillTarget(target, value, purpose);
    if (result.ok && purpose === "otp" && target) {
      window.setTimeout(() => { submitOtpForm(target); }, 120);
    }
    sendResponse(result);
    return false;
  }
  if (message.type === "UI_STATE" && window.top === window && panel) {
    panel.update(message.state as PanelState);
    panel.updateAddress(message.address as { host?: string; port?: number } | undefined);
  }
  if (message.type === "POLICY_DISABLED") {
    enabled = false;
    lastTarget = null;
    panel?.destroy();
    panel = null;
  }
  return false;
});

async function initialize(): Promise<void> {
  let response: { ok?: boolean; allowed?: boolean; position?: PanelPosition; state?: PanelState; soundEnabled?: boolean };
  try {
    response = await chrome.runtime.sendMessage({ type: "GET_CONTENT_INIT", policyUrl });
  } catch {
    return;
  }
  if (!response?.ok || !response.allowed) return;
  enabled = true;
  document.addEventListener("focusin", trackFocus, true);
  if (window.top === window) {
    await domReady();
    panel = new BridgePanel(response.position, response.soundEnabled !== false);
    if (response.state) panel.update(response.state);
  }
}

function trackFocus(event: FocusEvent): void {
  if (!enabled) return;
  const target = event.composedPath().find((entry) => isEditableTarget(entry)) as EditableTarget | undefined;
  if (!target) return;
  lastTarget = target;
  if (window.top === window) panel?.avoidTarget(target);
  void chrome.runtime.sendMessage({ type: "TARGET_FOCUSED", kind: classifyTarget(target), policyUrl }).catch(() => undefined);
}

class BridgePanel {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "closed" });
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly phoneText: HTMLElement;
  private readonly main: HTMLElement;
  private readonly settingsArea: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly soundEnabled: boolean;
  private currentState: PanelState = { connection: "unpaired", waitState: "IDLE", maskedPhone: "未配置" };
  private previousWaitState = "IDLE";
  private collapsed = false;
  private destroyed = false;
  private settingsOpen = false;
  private settingsConfig: InlineSettingsConfig | null = null;
  private readonly refreshTimer: number;
  private dragStart: { pointerX: number; pointerY: number; left: number; top: number } | null = null;
  private dragMoved = false;

  constructor(position?: PanelPosition, soundEnabled = true) {
    this.soundEnabled = soundEnabled;
    this.host.id = "wifi-otp-relay-host";
    this.host.style.cssText = `all:initial;position:fixed;z-index:2147483647;top:${DEFAULT_TOP}px;right:10px;width:${PANEL_WIDTH}px;color-scheme:light;`;
    if (position) {
      this.host.style.left = `${position.x}px`;
      this.host.style.top = `${position.y <= 24 ? DEFAULT_TOP : position.y}px`;
      this.host.style.right = "auto";
      this.collapsed = position.collapsed;
    }
    this.shadow.innerHTML = `${styles}
      <section class="panel" role="complementary" aria-label="验证码传递">
        <header class="header">
          <span class="signal" aria-hidden="true">✓</span><strong class="title">验证码传递</strong><span class="dot"></span>
          <button class="icon collapse" title="折叠" aria-label="折叠">−</button>
        </header>
        <div class="body">
          <div class="meta"><span class="status">未配对</span><span class="phone">未配置</span></div>
          <main></main>
          <div class="inline-settings hidden"></div>
          <p class="error" aria-live="polite"></p>
          <footer><button class="link settings">展开设置</button><button class="link hide">隐藏本站</button></footer>
        </div>
      </section>`;
    this.statusDot = required(".dot", this.shadow);
    this.statusText = required(".status", this.shadow);
    this.phoneText = required(".phone", this.shadow);
    this.main = required("main", this.shadow);
    this.settingsArea = required(".inline-settings", this.shadow);
    this.errorText = required(".error", this.shadow);
    this.collapseButton = required(".collapse", this.shadow) as HTMLButtonElement;
    const header = required(".header", this.shadow);
    this.settingsButton = required(".settings", this.shadow) as HTMLButtonElement;
    const hide = required(".hide", this.shadow);
    this.collapseButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setCollapsed(!this.collapsed);
    });
    this.settingsButton.addEventListener("click", () => { void this.toggleSettings(); });
    hide.addEventListener("click", () => {
      void this.action("HIDE_SITE").then((result) => { if (result) this.destroy(); });
    });
    header.addEventListener("pointerdown", (event) => this.startDrag(event as PointerEvent));
    header.addEventListener("pointermove", (event) => this.moveDrag(event as PointerEvent));
    header.addEventListener("pointerup", (event) => this.endDrag(event as PointerEvent));
    header.addEventListener("click", (event) => {
      if (!this.collapsed || (event.target as Element).closest("button")) return;
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      this.setCollapsed(false);
    });
    this.applyCollapsed();
    document.documentElement.append(this.host);
    this.refreshTimer = window.setInterval(() => {
      if (!this.destroyed && !this.host.isConnected) document.documentElement.append(this.host);
      this.renderMain();
    }, 1_000);
  }

  destroy(): void {
    this.destroyed = true;
    window.clearInterval(this.refreshTimer);
    this.host.remove();
  }

  avoidTarget(target: EditableTarget): void {
    window.requestAnimationFrame(() => {
      if (this.destroyed || this.collapsed || this.settingsOpen) return;
      const targetRect = target.getBoundingClientRect();
      const panelRect = this.host.getBoundingClientRect();
      if (!rectsOverlap(targetRect, panelRect, 8)) return;
      const nextTop = targetRect.top > panelRect.height + 16
        ? 8
        : clamp(targetRect.bottom + 10, 8, window.innerHeight - panelRect.height - 8);
      this.host.style.top = `${nextTop}px`;
      this.host.style.right = "10px";
      this.host.style.left = "auto";
      this.savePosition();
    });
  }

  update(next: PanelState): void {
    this.previousWaitState = this.currentState.waitState;
    this.currentState = next;
    this.statusDot.dataset.state = next.connection;
    this.statusText.textContent = connectionLabel(next.connection, next.notificationAccess);
    this.phoneText.textContent = next.maskedPhone;
    if (!this.settingsOpen || next.error) this.showFeedback(next.error ?? "", true);
    this.renderMain();
    if (next.waitState === "CODE_READY" && this.previousWaitState !== "CODE_READY" && this.soundEnabled) playTone();
  }

  updateAddress(address?: { host?: string; port?: number }): void {
    if (!this.settingsOpen || !this.settingsConfig || !address) return;
    const host = String(address.host ?? "");
    const port = Number(address.port);
    if (!host || !Number.isInteger(port) || (host === this.settingsConfig.host && port === this.settingsConfig.port)) return;
    this.settingsConfig = { ...this.settingsConfig, host, port };
    this.renderSettings();
    this.showFeedback(`已自动找到手机新地址 ${host}`);
  }

  private renderMain(): void {
    if (this.destroyed) return;
    const state = this.currentState;
    this.main.replaceChildren();
    if (state.waitState === "IDLE") {
      const phoneConfigured = state.maskedPhone !== "未配置";
      const fillButton = this.actionButton(phoneConfigured ? "点击手机号输入框，一键填充并等待" : "请先展开设置并填写手机号", "primary", "UI_FILL_PHONE");
      fillButton.disabled = !phoneConfigured;
      this.main.append(fillButton);
      return;
    }
    if (state.waitState === "ARMED" || state.waitState === "ARMED_OFFLINE") {
      const countdown = formatRemaining(state.waitExpiresAt);
      this.main.append(
        element("p", "eyebrow", state.waitState === "ARMED" ? "正在等手机短信" : "正在找手机"),
        element("div", "countdown", countdown),
        this.actionButton("取消等待", "secondary", "UI_CANCEL_WAIT")
      );
      return;
    }
    if (state.waitState === "EXPIRED") {
      this.main.append(
        element("p", "hint", "本次等待已结束"),
        this.actionButton("重新等待", "primary", "UI_REARM")
      );
      return;
    }
    if (state.candidates?.length && !state.code) {
      this.main.append(element("p", "eyebrow", "请选择正确的验证码"));
      const choices = element("div", "choices");
      for (const candidate of state.candidates) {
        const button = element("button", "choice", candidate) as HTMLButtonElement;
        button.addEventListener("click", () => { void this.action("UI_SELECT_CANDIDATE", { code: candidate }); });
        choices.append(button);
      }
      this.main.append(choices, this.actionButton("丢弃", "secondary", "UI_DISCARD"));
      return;
    }
    if (state.code) {
      const source = [state.sourceAppLabel || "短信", state.receivedAt ? formatClock(state.receivedAt) : ""].filter(Boolean).join(" · ");
      this.main.append(
        element("p", "eyebrow", source),
        element("div", "code", state.code),
        element("p", "expires", `${formatRemaining(state.codeExpiresAt)} 后失效`),
        this.actionButton("写入验证码并登录", "primary", "UI_FILL_OTP")
      );
      const actions = element("div", "row");
      const copy = element("button", "button secondary", "复制") as HTMLButtonElement;
      copy.addEventListener("click", () => { void this.copyCode(); });
      actions.append(copy, this.actionButton("丢弃", "secondary", "UI_DISCARD"));
      this.main.append(actions);
    }
  }

  private async toggleSettings(): Promise<void> {
    this.settingsOpen = !this.settingsOpen;
    this.settingsButton.textContent = this.settingsOpen ? "收起设置" : "展开设置";
    this.settingsArea.classList.toggle("hidden", !this.settingsOpen);
    if (!this.settingsOpen) {
      this.settingsConfig = null;
      this.settingsArea.replaceChildren();
      this.showFeedback(this.currentState.error ?? "", true);
      return;
    }

    this.collapsed = false;
    this.applyCollapsed();
    this.savePosition();
    this.settingsArea.replaceChildren(element("p", "hint", "正在读取设置…"));
    this.showFeedback("");
    await this.loadSettings();
  }

  private async loadSettings(successMessage?: string): Promise<void> {
    const response = await this.action("GET_OPTIONS");
    if (!response) {
      this.settingsArea.replaceChildren(element("p", "hint", "读取失败，请收起后重试"));
      return;
    }
    this.syncSettingsConfig(response);
    this.renderSettings();
    if (successMessage) this.showFeedback(successMessage);
  }

  private syncSettingsConfig(response: Record<string, unknown>): void {
    const value = response.config as Partial<InlineSettingsConfig> | undefined;
    if (!value) return;
    const port = Number(value.port);
    this.settingsConfig = {
      clientId: String(value.clientId ?? ""),
      host: String(value.host ?? ""),
      port: Number.isInteger(port) ? port : 0,
      phoneNumber: String(value.phoneNumber ?? ""),
      paired: value.paired === true
    };
  }

  private renderSettings(): void {
    if (!this.settingsOpen || !this.settingsConfig) return;
    const config = this.settingsConfig;
    this.settingsArea.replaceChildren();

    const phoneSection = element("section", "settings-section phone-section");
    const phoneRow = element("div", "compact-phone-row");
    const phoneInput = document.createElement("input");
    phoneInput.type = "tel";
    phoneInput.value = config.phoneNumber;
    phoneInput.placeholder = "输入手机号";
    phoneInput.autocomplete = "tel";
    phoneInput.inputMode = "tel";
    const savePhoneButton = element("button", "button secondary compact-save", "保存") as HTMLButtonElement;
    savePhoneButton.addEventListener("click", () => {
      void this.runBusy(savePhoneButton, "保存中…", async () => {
        const response = await this.action("INLINE_SAVE_PHONE", { phoneNumber: phoneInput.value });
        if (!response) return;
        this.syncSettingsConfig(response);
        this.showFeedback(phoneInput.value.trim() ? "手机号已保存" : "手机号已清空");
      });
    });
    phoneRow.append(phoneInput, savePhoneButton);
    phoneSection.append(phoneRow);

    const pairingSection = element("section", "settings-section pairing-section");
    const heading = element("div", "section-heading");
    heading.append(
      element("div", "section-title", "手机配对"),
      element("span", `pair-state ${config.paired ? "paired" : ""}`, config.paired ? "已配对" : "未配对")
    );
    pairingSection.append(heading);

    const addressRow = element("div", "address-row");
    const host = settingsField("手机 Wi-Fi 地址", "text", config.host, "请输入");
    host.input.autocomplete = "off";
    host.input.inputMode = "decimal";
    const port = settingsField("端口", "number", config.port >= 1024 ? String(config.port) : "", "请输入");
    port.input.min = "1024";
    port.input.max = "65535";
    port.input.inputMode = "numeric";
    addressRow.append(host.field, port.field);
    pairingSection.append(addressRow);

    if (!config.paired) {
      const pairCode = settingsField("6 位配对码", "text", "", "手机上显示的 6 位数字");
      pairCode.input.autocomplete = "one-time-code";
      pairCode.input.inputMode = "numeric";
      pairCode.input.maxLength = 6;
      const pairButton = element("button", "button primary", "配对手机") as HTMLButtonElement;
      pairButton.addEventListener("click", () => {
        void this.runBusy(pairButton, "正在配对…", async () => {
          const phoneResponse = await this.action("INLINE_SAVE_PHONE", { phoneNumber: phoneInput.value });
          if (!phoneResponse) return;
          const addressResponse = await this.action("INLINE_SAVE_ADDRESS", {
            host: host.input.value,
            port: Number(port.input.value)
          });
          if (!addressResponse) return;
          this.syncSettingsConfig(addressResponse);
          await this.requestLocalNetworkPermission(host.input.value.trim(), Number(port.input.value));
          const stored = await this.action("PAIR", {
            host: host.input.value,
            port: Number(port.input.value),
            pairCode: pairCode.input.value.trim()
          });
          if (!stored) return;
          await this.loadSettings("配对成功，正在连接手机");
        });
      });
      pairingSection.append(
        pairCode.field,
        pairButton,
        element("p", "settings-help", "如 Chrome 询问访问本地网络设备，请点击“允许”。")
      );
    } else {
      const saveAddressButton = element("button", "button primary", "保存新地址并重连") as HTMLButtonElement;
      const updateSaveAddressButton = (): void => {
        const changed = host.input.value.trim() !== config.host || Number(port.input.value) !== config.port;
        saveAddressButton.hidden = !changed;
      };
      host.input.addEventListener("input", updateSaveAddressButton);
      port.input.addEventListener("input", updateSaveAddressButton);
      updateSaveAddressButton();
      saveAddressButton.addEventListener("click", () => {
        void this.runBusy(saveAddressButton, "保存中…", async () => {
          const phoneResponse = await this.action("INLINE_SAVE_PHONE", { phoneNumber: phoneInput.value });
          if (!phoneResponse) return;
          const response = await this.action("INLINE_SAVE_ADDRESS", {
            host: host.input.value,
            port: Number(port.input.value)
          });
          if (!response) return;
          await this.loadSettings("新地址已保存，正在重新连接");
        });
      });
      const unpairButton = element("button", "button secondary danger", "更换手机") as HTMLButtonElement;
      unpairButton.addEventListener("click", () => {
        if (unpairButton.dataset.confirm !== "true") {
          unpairButton.dataset.confirm = "true";
          unpairButton.textContent = "再次点击确认";
          this.showFeedback("再次点击即可解除配对");
          window.setTimeout(() => {
            if (!unpairButton.isConnected) return;
            delete unpairButton.dataset.confirm;
            unpairButton.textContent = "更换手机";
          }, 4_000);
          return;
        }
        void this.runBusy(unpairButton, "正在解除…", async () => {
          const response = await this.action("UNPAIR");
          if (!response) return;
          await this.loadSettings("已解除配对");
        });
      });
      pairingSection.append(saveAddressButton, unpairButton);
    }

    this.settingsArea.append(phoneSection, pairingSection);
  }

  private async requestLocalNetworkPermission(host: string, port: number): Promise<void> {
    const token = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      let timeout = 0;
      const finish = (error?: Error): void => {
        window.clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(onMessage);
        if (error) reject(error); else resolve();
      };
      const onMessage = (message: Record<string, unknown>): false => {
        if (message.type !== "LOCAL_NETWORK_PROBE_RESULT" || message.token !== token) return false;
        if (message.probeOk === true) finish();
        else finish(new Error(String(message.probeError ?? "浏览器未允许访问手机")));
        return false;
      };
      chrome.runtime.onMessage.addListener(onMessage);
      timeout = window.setTimeout(() => finish(new Error("授权窗口等待超时，请关闭窗口后重新点击配对")), 50_000);
      void chrome.runtime.sendMessage({
        type: "AUTHORIZE_LOCAL_NETWORK_PROBE",
        token,
        host,
        port
      }).then((authorization: Record<string, unknown> | undefined) => {
        if (!authorization?.ok) finish(new Error(String(authorization?.error ?? "无法打开浏览器授权窗口")));
      }).catch(() => finish(new Error("无法打开浏览器授权窗口")));
    });
  }

  private async runBusy(button: HTMLButtonElement, busyLabel: string, task: () => Promise<void>): Promise<void> {
    const originalLabel = button.textContent ?? "";
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await task();
    } catch (error) {
      this.showFeedback(error instanceof Error ? error.message : "操作失败", true);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  private actionButton(label: string, className: string, type: string): HTMLButtonElement {
    const button = element("button", `button ${className}`, label) as HTMLButtonElement;
    button.addEventListener("click", () => { void this.action(type); });
    return button;
  }

  private async action(type: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    try {
      const response = await chrome.runtime.sendMessage({ type, ...extra }) as Record<string, unknown> | undefined;
      if (!response?.ok) {
        this.showFeedback(String(response?.error ?? "操作失败"), true);
        return null;
      }
      this.showFeedback("");
      return response;
    } catch (error) {
      this.showFeedback(error instanceof Error ? error.message : "扩展后台未响应", true);
      return null;
    }
  }

  private showFeedback(message: string, error = false): void {
    this.errorText.textContent = message;
    this.errorText.dataset.kind = error ? "error" : "success";
  }

  private async copyCode(): Promise<void> {
    try {
      const response = await this.action("UI_GET_CODE");
      if (!response) return;
      const code = String(response.code ?? "");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = code;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        this.shadow.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      this.showFeedback("已复制");
    } catch { /* action already displays a safe error */ }
  }

  private setCollapsed(value: boolean): void {
    this.collapsed = value;
    this.applyCollapsed();
    this.savePosition();
  }

  private applyCollapsed(): void {
    this.host.style.width = `${this.collapsed ? COLLAPSED_WIDTH : PANEL_WIDTH}px`;
    required(".panel", this.shadow).classList.toggle("collapsed", this.collapsed);
    required(".body", this.shadow).classList.toggle("hidden", this.collapsed);
    this.collapseButton.textContent = "−";
    this.collapseButton.title = this.collapsed ? "展开" : "折叠";
    this.collapseButton.setAttribute("aria-label", this.collapsed ? "展开" : "折叠");
  }

  private startDrag(event: PointerEvent): void {
    if ((event.target as Element).closest("button")) return;
    const rect = this.host.getBoundingClientRect();
    this.host.style.left = `${rect.left}px`;
    this.host.style.top = `${rect.top}px`;
    this.host.style.right = "auto";
    this.dragMoved = false;
    this.dragStart = { pointerX: event.clientX, pointerY: event.clientY, left: rect.left, top: rect.top };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }

  private moveDrag(event: PointerEvent): void {
    if (!this.dragStart) return;
    if (Math.abs(event.clientX - this.dragStart.pointerX) > 3 || Math.abs(event.clientY - this.dragStart.pointerY) > 3) {
      this.dragMoved = true;
    }
    const width = this.host.getBoundingClientRect().width;
    const x = clamp(this.dragStart.left + event.clientX - this.dragStart.pointerX, 8, window.innerWidth - width - 8);
    const y = clamp(this.dragStart.top + event.clientY - this.dragStart.pointerY, 8, window.innerHeight - 48);
    this.host.style.left = `${x}px`;
    this.host.style.top = `${y}px`;
  }

  private endDrag(event: PointerEvent): void {
    if (!this.dragStart) return;
    this.dragStart = null;
    (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    this.savePosition();
  }

  private savePosition(): void {
    const rect = this.host.getBoundingClientRect();
    void chrome.runtime.sendMessage({
      type: "SET_PANEL_POSITION",
      position: { x: rect.left, y: rect.top, collapsed: this.collapsed }
    }).catch(() => undefined);
  }
}

function effectivePolicyUrl(): string {
  if (/^https?:/i.test(location.href)) return location.href;
  if (/^https?:/i.test(document.referrer)) return document.referrer;
  try {
    if (location.origin !== "null" && /^https?:/i.test(location.origin)) return location.origin;
  } catch { /* cross-origin access is intentionally ignored */ }
  return "";
}

function domReady(): Promise<void> {
  if (document.documentElement) return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
}

function required(selector: string, root: ShadowRoot): HTMLElement {
  const value = root.querySelector(selector);
  if (!(value instanceof HTMLElement)) throw new Error(`Missing panel element: ${selector}`);
  return value;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function settingsField(
  labelText: string,
  type: string,
  value: string,
  placeholder: string
): { field: HTMLElement; input: HTMLInputElement } {
  const field = element("label", "field");
  const label = element("span", "field-label", labelText);
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  field.append(label, input);
  return { field, input };
}

function connectionLabel(connection: PanelState["connection"], notificationAccess?: boolean): string {
  if (connection === "unpaired") return "未配对";
  if (connection === "connecting") return "连接中";
  if (connection === "offline") return "手机离线";
  return notificationAccess === false ? "通知权限异常" : "手机在线";
}

function formatRemaining(expiresAt?: number): string {
  const seconds = Math.max(0, Math.ceil(((expiresAt ?? Date.now()) - Date.now()) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function rectsOverlap(a: DOMRect, b: DOMRect, padding = 0): boolean {
  return a.left < b.right + padding && a.right > b.left - padding &&
    a.top < b.bottom + padding && a.bottom > b.top - padding;
}

function playTone(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.05, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    oscillator.addEventListener("ended", () => { void context.close(); }, { once: true });
  } catch { /* autoplay policy can suppress a non-essential cue */ }
}

const styles = `<style>
  :host{all:initial;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.35;color:#1a2331}
  *{box-sizing:border-box}
  .panel{overflow:hidden;border:1px solid #dce2e9;border-radius:14px;background:#fff;box-shadow:0 14px 34px rgba(24,36,54,.16)}.panel.collapsed{border-radius:19px;box-shadow:0 6px 18px rgba(24,36,54,.13)}
  .header{height:38px;display:flex;align-items:center;gap:6px;padding:0 7px 0 9px;background:#f5f7fa;cursor:move;user-select:none;touch-action:none}
  .panel.collapsed .header{gap:7px;padding:0 10px 0 8px;background:#fff;cursor:pointer}.panel.collapsed .title{flex:none;white-space:nowrap}.panel.collapsed .dot{margin-left:auto}.panel.collapsed .collapse{display:none}
  .signal{display:grid;place-items:center;width:21px;height:21px;border-radius:6px;background:#2563eb;color:#fff;font-size:12px;font-weight:900}.dot{width:7px;height:7px;border-radius:50%;background:#9aa4b2}.dot[data-state="online"]{background:#079669;box-shadow:0 0 0 3px #dcf6eb}.dot[data-state="connecting"]{background:#dc9a1b}.dot[data-state="offline"]{background:#dc5151}
  .title{flex:1;font-size:11px;color:#1a2331}.icon{width:25px;height:25px;border:0;border-radius:7px;background:transparent;color:#667085;font-size:16px;cursor:pointer}.icon:hover{background:#e7ebf0;color:#1a2331}
  .body{max-height:calc(100vh - 48px);overflow-y:auto;padding:9px}.body.hidden{display:none}.meta{display:flex;justify-content:space-between;gap:6px;color:#7a8596;font-size:9px;margin-bottom:7px}
  main{display:grid;gap:7px}.hint,.eyebrow,.expires{margin:0;color:#7a8596;font-size:9px}.hint,.eyebrow{text-align:center}.countdown,.code{text-align:center;font-variant-numeric:tabular-nums}.countdown{font-size:24px;font-weight:750;color:#1f2937}.code{font-size:29px;font-weight:850;letter-spacing:.1em;color:#2563eb}.expires{text-align:center}
  .button,.choice{appearance:none;border:0;border-radius:8px;min-height:32px;padding:6px 9px;font-family:inherit;font-size:10px;font-weight:700;line-height:1.25;white-space:nowrap;cursor:pointer}.button[hidden]{display:none!important}.button:disabled,.choice:disabled{cursor:not-allowed}.primary{background:#2563eb;color:#fff}.primary:hover{background:#1d4ed8}.primary:disabled{background:#e4e7ec;color:#667085}.secondary{background:#edf1f6;color:#435066}.secondary:hover{background:#e2e7ed}.danger{color:#b42318}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.choices{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}.choice{background:#e8efff;color:#1d4ed8;font-size:17px;font-variant-numeric:tabular-nums}
  .inline-settings{display:grid;gap:6px;margin-top:7px;padding-top:7px;border-top:1px solid #e7ebf0}.inline-settings.hidden{display:none}.settings-section{display:grid;gap:6px}.pairing-section{padding-top:7px;border-top:1px solid #e7ebf0}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.section-title{font-size:11px;font-weight:800;color:#202939}.pair-state{border-radius:999px;background:#f0f2f5;padding:2px 6px;color:#667085;font-size:9px;font-weight:700}.pair-state.paired{background:#e7f8ef;color:#067647}.field{display:grid;gap:3px}.field-label{color:#667085;font-size:9px}.field input,.compact-phone-row input{width:100%;height:30px;border:1px solid #d8dee8;border-radius:7px;outline:0;background:#fff;padding:0 8px;color:#1d2939;font:10px Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}.field input::placeholder,.compact-phone-row input::placeholder{color:#a2aab7}.field input:focus,.compact-phone-row input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}.compact-phone-row{display:grid;grid-template-columns:minmax(0,1fr) 48px;gap:5px}.compact-save{min-height:30px;padding:5px}.address-row{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(65px,.75fr);gap:5px}.settings-help{margin:0;color:#667085;font-size:9px;line-height:1.45}
  .error{margin:6px 0 0;color:#c43c3c;font-size:9px}.error[data-kind="success"]{color:#067647}.error:empty{display:none}footer{display:flex;justify-content:space-between;margin-top:7px;padding-top:6px;border-top:1px solid #edf0f3}.link{border:0;background:transparent;padding:1px;color:#748093;font-family:inherit;font-size:9px;line-height:1.2;cursor:pointer}.link:hover{color:#2563eb;text-decoration:underline}
</style>`;
