export type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
export type FillPurpose = "phone" | "otp";

const rejectedInputTypes = new Set(["hidden", "button", "submit", "reset", "checkbox", "radio", "file", "password"]);

export function isEditableTarget(value: EventTarget | null): value is EditableTarget {
  if (!(value instanceof Element)) return false;
  if (value instanceof HTMLInputElement) {
    return !rejectedInputTypes.has(value.type.toLowerCase()) && !value.disabled && !value.readOnly;
  }
  if (value instanceof HTMLTextAreaElement) return !value.disabled && !value.readOnly;
  return value instanceof HTMLElement && value.isContentEditable;
}

export function isVisible(target: EditableTarget): boolean {
  if (!target.isConnected) return false;
  const style = target.ownerDocument.defaultView?.getComputedStyle(target);
  if (!style || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  return target.getClientRects().length > 0;
}

export function classifyTarget(target: EditableTarget): "phone" | "otp" | "generic" {
  const hints = [
    target.getAttribute("name"),
    target.getAttribute("id"),
    target.getAttribute("placeholder"),
    target.getAttribute("aria-label"),
    target.getAttribute("autocomplete")
  ].filter(Boolean).join(" ").toLowerCase();
  if (target instanceof HTMLInputElement && target.type === "tel") return "phone";
  if (/phone|mobile|tel|手机|电话/.test(hints)) return "phone";
  if (/one-time-code|otp|verify|verification|captcha|验证码|校验码|动态码/.test(hints)) return "otp";
  if (target instanceof HTMLInputElement && target.maxLength === 1) return "otp";
  return "generic";
}

export function fillTarget(target: EditableTarget | null, value: string, purpose: FillPurpose): { ok: boolean; error?: string } {
  if (!target || !isEditableTarget(target) || !isVisible(target)) return { ok: false, error: "请重新点击可见且可编辑的输入框" };
  if (!/^\+?\d+$/.test(value)) return { ok: false, error: "填充值格式无效" };

  if (purpose === "otp" && target instanceof HTMLInputElement && target.maxLength === 1) {
    const group = findOtpGroup(target);
    if (group && group.length !== value.length) return { ok: false, error: "验证码长度与分格数量不匹配" };
    if (group) {
      for (const input of group) {
        if (!isEditableTarget(input) || !isVisible(input)) return { ok: false, error: "验证码分格不可编辑" };
      }
      group.forEach((input, index) => setNativeValue(input, value[index]!));
      group.at(-1)?.focus({ preventScroll: true });
      return { ok: true };
    }
  }

  if (target instanceof HTMLInputElement && target.maxLength > 0 && value.length > target.maxLength) {
    return { ok: false, error: "填充值超过输入框长度限制" };
  }
  if (target instanceof HTMLTextAreaElement && target.maxLength > 0 && value.length > target.maxLength) {
    return { ok: false, error: "填充值超过输入框长度限制" };
  }

  const updated = setNativeValue(target, value);
  return updated ? { ok: true } : { ok: false, error: "页面拒绝了输入事件" };
}

export function findOtpTarget(document: Document, previous: EditableTarget | null, code: string): EditableTarget | null {
  if (previous && isEditableTarget(previous) && isVisible(previous) && classifyTarget(previous) === "otp") return previous;
  const candidates = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
    .filter((value): value is EditableTarget => isEditableTarget(value) && isVisible(value))
    .map((target) => ({ target, score: otpTargetScore(target, code) }))
    .filter((entry) => entry.score >= 20)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.target ?? null;
}

export function submitOtpForm(target: EditableTarget): boolean {
  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  const form = target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement
    ? target.form
    : target.closest("form");
  if (!form) return false;
  const controls = Array.from(form.querySelectorAll("button, input[type='submit']"))
    .filter((control): control is HTMLButtonElement | HTMLInputElement =>
      (control instanceof view.HTMLButtonElement || control instanceof view.HTMLInputElement) &&
      !control.disabled && control.getClientRects().length > 0
    );
  const safeControls = controls.filter((control) => !/发送|获取|重发|验证码|send\s*code|get\s*code|resend/i.test(controlLabel(control)));
  const explicit = safeControls.filter((control) => /登录|登陆|注册|提交|确认|继续|完成|log\s*in|sign\s*in|submit|continue|verify/i.test(controlLabel(control)));
  const selected = explicit.length === 1
    ? explicit[0]
    : safeControls.length === 1 && isSubmitControl(safeControls[0]!) ? safeControls[0]
    : undefined;
  if (!selected) return false;
  selected.click();
  return true;
}

function otpTargetScore(target: EditableTarget, code: string): number {
  let score = classifyTarget(target) === "otp" ? 50 : 0;
  if (target.getAttribute("autocomplete")?.toLowerCase() === "one-time-code") score += 80;
  if (target instanceof HTMLInputElement) {
    if (target.maxLength === code.length) score += 35;
    if (target.maxLength === 1) score += 20;
    if (target.inputMode === "numeric" || target.type === "number" || target.pattern?.includes("d")) score += 8;
  }
  return score;
}

function controlLabel(control: HTMLButtonElement | HTMLInputElement): string {
  return `${control.textContent ?? ""} ${control.value ?? ""} ${control.getAttribute("aria-label") ?? ""}`.trim();
}

function isSubmitControl(control: HTMLButtonElement | HTMLInputElement): boolean {
  if (control instanceof HTMLInputElement) return control.type === "submit";
  return !control.type || control.type === "submit";
}

function findOtpGroup(target: HTMLInputElement): HTMLInputElement[] | null {
  let container: Element | null = target.parentElement;
  for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
    const inputs = Array.from(container.querySelectorAll("input"))
      .filter((input): input is HTMLInputElement => input instanceof HTMLInputElement)
      .filter((input) => input.maxLength === 1 && isEditableTarget(input) && isVisible(input));
    if (inputs.includes(target) && inputs.length >= 4 && inputs.length <= 8) return inputs;
  }
  return null;
}

function setNativeValue(target: EditableTarget, value: string): boolean {
  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  target.focus({ preventScroll: true });
  const beforeInput = createInputEvent(view, "beforeinput", value, true);
  if (!target.dispatchEvent(beforeInput)) return false;

  if (target instanceof view.HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(target, value);
    try { target.setSelectionRange(value.length, value.length); } catch { /* number inputs do not support selection */ }
  } else if (target instanceof view.HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(target, value);
    target.setSelectionRange(value.length, value.length);
  } else {
    target.textContent = value;
  }

  target.dispatchEvent(createInputEvent(view, "input", value, false));
  target.dispatchEvent(new view.Event("change", { bubbles: true }));
  return true;
}

function createInputEvent(view: Window & typeof globalThis, type: string, data: string, cancelable: boolean): Event {
  try {
    return new view.InputEvent(type, {
      bubbles: true,
      composed: true,
      cancelable,
      inputType: "insertText",
      data
    });
  } catch {
    return new view.Event(type, { bubbles: true, cancelable });
  }
}
