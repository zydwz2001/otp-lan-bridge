import { beforeEach, describe, expect, it, vi } from "vitest";
import { fillTarget } from "../src/fill";

function visible<T extends HTMLElement>(element: T): T {
  Object.defineProperty(element, "getClientRects", { configurable: true, value: () => ({ length: 1 }) as DOMRectList });
  return element;
}

describe("fillTarget", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("updates a native input and emits framework-compatible events", () => {
    const input = visible(document.createElement("input"));
    document.body.append(input);
    const events: string[] = [];
    input.addEventListener("beforeinput", () => events.push("beforeinput"));
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    expect(fillTarget(input, "13800138000", "phone")).toEqual({ ok: true });
    expect(input.value).toBe("13800138000");
    expect(events).toEqual(["beforeinput", "input", "change"]);
  });

  it("rejects disabled, readonly, and detached controls", () => {
    const disabled = visible(document.createElement("input"));
    disabled.disabled = true;
    document.body.append(disabled);
    expect(fillTarget(disabled, "1234", "otp").ok).toBe(false);

    const readonly = visible(document.createElement("input"));
    readonly.readOnly = true;
    document.body.append(readonly);
    expect(fillTarget(readonly, "1234", "otp").ok).toBe(false);

    const detached = visible(document.createElement("input"));
    expect(fillTarget(detached, "1234", "otp").ok).toBe(false);
  });

  it("fills a six-cell OTP group in visual DOM order", () => {
    const group = document.createElement("div");
    const inputs = Array.from({ length: 6 }, () => {
      const input = visible(document.createElement("input"));
      input.maxLength = 1;
      group.append(input);
      return input;
    });
    document.body.append(group);

    expect(fillTarget(inputs[2]!, "483921", "otp")).toEqual({ ok: true });
    expect(inputs.map((input) => input.value).join("")).toBe("483921");
  });

  it("rejects a code whose length does not match the OTP group", () => {
    const group = document.createElement("div");
    const inputs = Array.from({ length: 4 }, () => {
      const input = visible(document.createElement("input"));
      input.maxLength = 1;
      group.append(input);
      return input;
    });
    document.body.append(group);
    expect(fillTarget(inputs[0]!, "123456", "otp").ok).toBe(false);
    expect(inputs.every((input) => input.value === "")).toBe(true);
  });

  it("uses the native setter when a framework shadows the value property", () => {
    const input = visible(document.createElement("input"));
    document.body.append(input);
    Object.defineProperty(input, "value", { configurable: true, writable: true, value: "stale" });
    expect(fillTarget(input, "7254", "otp").ok).toBe(true);
    expect(Object.getOwnPropertyDescriptor(input, "value")?.value).toBe("stale");
    Reflect.deleteProperty(input, "value");
    expect(input.value).toBe("7254");
  });
});
