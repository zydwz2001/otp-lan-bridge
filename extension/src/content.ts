import { classifyTarget, fillTarget, isEditableTarget, type EditableTarget } from "./fill";
import type { PanelPosition, PanelState } from "./types";

let enabled = false;
let lastTarget: EditableTarget | null = null;
let panel: BridgePanel | null = null;
const policyUrl = effectivePolicyUrl();
const PANEL_WIDTH = 248;
const COLLAPSED_WIDTH = 132;
const DEFAULT_TOP = 88;

void initialize();

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  if (message.type === "FILL_VALUE") {
    const purpose = message.purpose === "phone" ? "phone" : "otp";
    const value = String(message.value ?? "");
    sendResponse(fillTarget(lastTarget, value, purpose));
    return false;
  }
  if (message.type === "UI_STATE" && window.top === window && panel) {
    panel.update(message.state as PanelState);
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
  void chrome.runtime.sendMessage({ type: "TARGET_FOCUSED", kind: classifyTarget(target), policyUrl }).catch(() => undefined);
}

class BridgePanel {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "closed" });
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly phoneText: HTMLElement;
  private readonly main: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly soundEnabled: boolean;
  private currentState: PanelState = { connection: "unpaired", waitState: "IDLE", maskedPhone: "未配置" };
  private previousWaitState = "IDLE";
  private collapsed = false;
  private destroyed = false;
  private readonly refreshTimer: number;
  private dragStart: { pointerX: number; pointerY: number; left: number; top: number } | null = null;

  constructor(position?: PanelPosition, soundEnabled = true) {
    this.soundEnabled = soundEnabled;
    this.host.id = "otp-lan-bridge-host";
    this.host.style.cssText = `all:initial;position:fixed;z-index:2147483647;top:${DEFAULT_TOP}px;right:16px;width:${PANEL_WIDTH}px;color-scheme:light;`;
    if (position) {
      this.host.style.left = `${position.x}px`;
      this.host.style.top = `${position.y <= 24 ? DEFAULT_TOP : position.y}px`;
      this.host.style.right = "auto";
      this.collapsed = position.collapsed;
    }
    this.shadow.innerHTML = `${styles}
      <section class="panel" role="complementary" aria-label="验证码桥接">
        <header class="header">
          <span class="dot"></span><strong class="title">验证码桥接</strong>
          <button class="icon collapse" title="折叠" aria-label="折叠">−</button>
        </header>
        <div class="body">
          <div class="meta"><span class="status">未配对</span><span class="phone">未配置</span></div>
          <main></main>
          <p class="error" aria-live="polite"></p>
          <footer><button class="link settings">设置</button><button class="link hide">隐藏本站</button></footer>
        </div>
      </section>`;
    this.statusDot = required(".dot", this.shadow);
    this.statusText = required(".status", this.shadow);
    this.phoneText = required(".phone", this.shadow);
    this.main = required("main", this.shadow);
    this.errorText = required(".error", this.shadow);
    this.collapseButton = required(".collapse", this.shadow) as HTMLButtonElement;
    const header = required(".header", this.shadow);
    const settings = required(".settings", this.shadow);
    const hide = required(".hide", this.shadow);
    this.collapseButton.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
    hide.addEventListener("click", () => {
      void this.action("HIDE_SITE").then((result) => { if (result) this.destroy(); });
    });
    header.addEventListener("pointerdown", (event) => this.startDrag(event as PointerEvent));
    header.addEventListener("pointermove", (event) => this.moveDrag(event as PointerEvent));
    header.addEventListener("pointerup", (event) => this.endDrag(event as PointerEvent));
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

  update(next: PanelState): void {
    this.previousWaitState = this.currentState.waitState;
    this.currentState = next;
    this.statusDot.dataset.state = next.connection;
    this.statusText.textContent = connectionLabel(next.connection, next.notificationAccess);
    this.phoneText.textContent = next.maskedPhone;
    this.errorText.textContent = next.error ?? "";
    this.renderMain();
    if (next.waitState === "CODE_READY" && this.previousWaitState !== "CODE_READY" && this.soundEnabled) playTone();
  }

  private renderMain(): void {
    if (this.destroyed) return;
    const state = this.currentState;
    this.main.replaceChildren();
    if (state.waitState === "IDLE") {
      this.main.append(this.actionButton("填充手机号", "primary", "UI_FILL_PHONE"));
      return;
    }
    if (state.waitState === "ARMED" || state.waitState === "ARMED_OFFLINE") {
      const countdown = formatRemaining(state.waitExpiresAt);
      this.main.append(
        element("p", "eyebrow", state.waitState === "ARMED" ? "等待短信验证码" : "等待连接手机"),
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
        this.actionButton("填充验证码", "primary", "UI_FILL_OTP")
      );
      const actions = element("div", "row");
      const copy = element("button", "button secondary", "复制") as HTMLButtonElement;
      copy.addEventListener("click", () => { void this.copyCode(); });
      actions.append(copy, this.actionButton("丢弃", "secondary", "UI_DISCARD"));
      this.main.append(actions);
    }
  }

  private actionButton(label: string, className: string, type: string): HTMLButtonElement {
    const button = element("button", `button ${className}`, label) as HTMLButtonElement;
    button.addEventListener("click", () => { void this.action(type); });
    return button;
  }

  private async action(type: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    const response = await chrome.runtime.sendMessage({ type, ...extra }) as Record<string, unknown> | undefined;
    if (!response?.ok) {
      this.errorText.textContent = String(response?.error ?? "操作失败");
      return null;
    }
    this.errorText.textContent = "";
    return response;
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
      this.errorText.textContent = "已复制";
    } catch { /* action already displays a safe error */ }
  }

  private setCollapsed(value: boolean): void {
    this.collapsed = value;
    this.applyCollapsed();
    this.savePosition();
  }

  private applyCollapsed(): void {
    this.host.style.width = `${this.collapsed ? COLLAPSED_WIDTH : PANEL_WIDTH}px`;
    required(".body", this.shadow).classList.toggle("hidden", this.collapsed);
    this.collapseButton.textContent = this.collapsed ? "+" : "−";
    this.collapseButton.title = this.collapsed ? "展开" : "折叠";
  }

  private startDrag(event: PointerEvent): void {
    if ((event.target as Element).closest("button")) return;
    const rect = this.host.getBoundingClientRect();
    this.host.style.left = `${rect.left}px`;
    this.host.style.top = `${rect.top}px`;
    this.host.style.right = "auto";
    this.dragStart = { pointerX: event.clientX, pointerY: event.clientY, left: rect.left, top: rect.top };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }

  private moveDrag(event: PointerEvent): void {
    if (!this.dragStart) return;
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
  :host{all:initial;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.35;color:#172033}
  *{box-sizing:border-box}
  .panel{overflow:hidden;border:1px solid rgba(35,48,76,.14);border-radius:12px;background:#fff;box-shadow:0 10px 28px rgba(18,28,51,.16)}
  .header{height:38px;display:flex;align-items:center;gap:7px;padding:0 7px 0 11px;background:#f5f7fb;cursor:move;user-select:none;touch-action:none}
  .dot{width:8px;height:8px;border-radius:50%;background:#9aa3b2}.dot[data-state="online"]{background:#18a558}.dot[data-state="connecting"]{background:#e59b16}.dot[data-state="offline"]{background:#df4a4a}
  .title{flex:1;font-size:13px;color:#172033}.icon{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:#556177;font-size:17px;cursor:pointer}.icon:hover{background:#e7ebf3}
  .body{padding:10px 11px}.body.hidden{display:none}.meta{display:flex;justify-content:space-between;gap:7px;color:#697489;font-size:11px;margin-bottom:8px}
  main{display:grid;gap:8px}.hint,.eyebrow,.expires{margin:0;color:#697489;font-size:11px}.eyebrow{text-align:center}.countdown,.code{text-align:center;font-variant-numeric:tabular-nums}.countdown{font-size:25px;font-weight:700;color:#24324b}.code{font-size:32px;font-weight:800;letter-spacing:.1em;color:#173f9e}.expires{text-align:center}
  .button,.choice{appearance:none;border:0;border-radius:8px;min-height:34px;padding:7px 11px;font:600 12px inherit;cursor:pointer}.primary{background:#2457d6;color:#fff}.primary:hover{background:#1948bd}.secondary{background:#edf1f8;color:#33415d}.secondary:hover{background:#e2e8f2}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.choices{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}.choice{background:#eef3ff;color:#173f9e;font-size:17px;font-variant-numeric:tabular-nums}
  .error{margin:7px 0 0;color:#c03636;font-size:10px}.error:empty{display:none}footer{display:flex;justify-content:space-between;margin-top:7px;padding-top:7px;border-top:1px solid #edf0f5}.link{border:0;background:transparent;padding:1px;color:#63708a;font:10px inherit;cursor:pointer}.link:hover{color:#2457d6;text-decoration:underline}
</style>`;
