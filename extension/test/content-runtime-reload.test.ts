import { afterEach, beforeEach, expect, it, vi } from "vitest";

let shadow: ShadowRoot;
let tick: () => void;
let runtime: { id?: string; sendMessage: ReturnType<typeof vi.fn>; onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> } };
let listeners: Array<(message: Record<string, unknown>) => unknown>;
const refreshMessage = "插件已更新或重载，请刷新当前网页后继续";

beforeEach(() => {
  vi.resetModules();
  document.body.replaceChildren();
  listeners = [];
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
    shadow = attach.call(this, { mode: "open" });
    return shadow;
  });
  vi.spyOn(window, "setInterval").mockImplementation((callback) => { tick = callback as () => void; return 1; });
  runtime = {
    id: "test-id",
    sendMessage: vi.fn(async (message: Record<string, unknown>) => message.type === "GET_CONTENT_INIT" ? {
      ok: true, allowed: true, soundEnabled: false,
      state: { connection: "online", waitState: "IDLE", maskedPhone: "138****8000" }
    } : { ok: true }),
    onMessage: {
      addListener: vi.fn((listener) => listeners.push(listener)),
      removeListener: vi.fn()
    }
  };
  vi.stubGlobal("chrome", { runtime });
});

afterEach(() => {
  listeners.forEach((listener) => listener({ type: "POLICY_DISABLED" }));
  shadow?.host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openPanel(): Promise<void> {
  await import("../src/content");
  await vi.waitFor(() => expect(shadow?.querySelector(".status")?.textContent).toBe("手机在线"));
}

function expectInvalidated(): void {
  expect(shadow.querySelector(".status")?.textContent).toBe("页面待刷新");
  expect(shadow.querySelector(".dot")?.getAttribute("data-state")).toBe("offline");
  expect(shadow.querySelector(".error")?.textContent).toBe(refreshMessage);
  expect([...shadow.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  const calls = runtime.sendMessage.mock.calls.length;
  tick();
  const input = document.createElement("input");
  document.body.append(input);
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(runtime.sendMessage.mock.calls).toHaveLength(calls);
}

it.each(["throw", "reject"])("replaces a stale online state when settings messaging fails via %s", async (kind) => {
  await openPanel();
  runtime.sendMessage.mockImplementation((message: Record<string, unknown>) => {
    if (message.type !== "GET_OPTIONS") return Promise.resolve({ ok: true });
    const error = new Error("Extension context invalidated.");
    if (kind === "throw") throw error;
    return Promise.reject(error);
  });
  (shadow.querySelector(".settings") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow.querySelector(".error")?.textContent).toBe(refreshMessage));
  expectInvalidated();
  expect(shadow.querySelector(".inline-settings")?.textContent).not.toContain("收起后重试");
});

it("detects reload without a click and ignores a delayed online state", async () => {
  await openPanel();
  runtime.id = undefined;
  tick();
  listeners.forEach((listener) => listener({ type: "UI_STATE", state: { connection: "online", waitState: "IDLE", maskedPhone: "138****8000" } }));
  expectInvalidated();
});

it("keeps ordinary background errors retryable", async () => {
  await openPanel();
  runtime.sendMessage.mockImplementation((message: Record<string, unknown>) => {
    if (message.type === "GET_OPTIONS") return Promise.reject(new Error("后台暂时未响应"));
    return Promise.resolve({ ok: true });
  });
  (shadow.querySelector(".settings") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow.querySelector(".error")?.textContent).toBe("后台暂时未响应"));
  expect(shadow.querySelector(".status")?.textContent).toBe("手机在线");
  expect((shadow.querySelector(".settings") as HTMLButtonElement).disabled).toBe(false);
});
