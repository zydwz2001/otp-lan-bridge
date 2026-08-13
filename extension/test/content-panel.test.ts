import { expect, it, vi } from "vitest";

it("opens phone and pairing settings inside the floating panel", async () => {
  let shadow: ShadowRoot | undefined;
  const nativeAttachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
    shadow = nativeAttachShadow.call(this, { mode: "open" });
    return shadow;
  });
  vi.spyOn(window, "setInterval").mockReturnValue(1);

  const openOptionsPage = vi.fn();
  let paired = false;
  let savedHost = "";
  let savedPort = 0;
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === "GET_CONTENT_INIT") {
      return {
        ok: true,
        allowed: true,
        soundEnabled: true,
        state: { connection: "unpaired", waitState: "IDLE", maskedPhone: "未配置" }
      };
    }
    if (message.type === "GET_OPTIONS") {
      return {
        ok: true,
        config: {
          clientId: "browser-client-id",
          host: savedHost,
          port: savedPort,
          phoneNumber: "13800138000",
          paired
        }
      };
    }
    if (message.type === "INLINE_SAVE_ADDRESS") {
      savedHost = String(message.host ?? "");
      savedPort = Number(message.port);
    }
    if (message.type === "PAIR") paired = true;
    return { ok: true };
  });
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage,
      openOptionsPage,
      getURL: (path: string) => `chrome-extension://test-id/${path}`
    }
  });

  await import("../src/content");
  await vi.waitFor(() => expect(shadow?.querySelector(".settings")).not.toBeNull());
  const fillButton = shadow!.querySelector("main .primary") as HTMLButtonElement;
  expect(fillButton.textContent).toBe("请先展开设置并填写手机号");
  expect(fillButton.disabled).toBe(true);
  (shadow!.querySelector(".settings") as HTMLButtonElement).click();

  await vi.waitFor(() => {
    expect(shadow!.querySelector<HTMLInputElement>('input[type="tel"]')?.value).toBe("13800138000");
  });
  const labels = [...shadow!.querySelectorAll(".field-label")].map((node) => node.textContent);
  const buttons = [...shadow!.querySelectorAll("button")].map((node) => node.textContent);
  expect(labels).toEqual(["手机 Wi-Fi 地址", "端口", "6 位配对码"]);
  expect(shadow!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.placeholder).toBe("请输入");
  const port = shadow!.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(port.value).toBe("");
  expect(port.placeholder).toBe("请输入");
  expect(buttons).toContain("保存");
  expect(buttons).toContain("配对手机");
  expect((shadow!.querySelector(".settings") as HTMLButtonElement).textContent).toBe("收起设置");
  expect((shadow!.host as HTMLElement).style.width).toBe("244px");
  expect(openOptionsPage).not.toHaveBeenCalled();

  const address = shadow!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const pairCode = shadow!.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
  address.value = "192.168.18.52";
  port.value = "42871";
  pairCode.value = "123456";
  const pairButton = [...shadow!.querySelectorAll("button")].find((button) => button.textContent === "配对手机")!;
  pairButton.click();
  const permissionFrame = await vi.waitFor(() => {
    const frame = shadow!.querySelector<HTMLIFrameElement>(".permission-frame");
    expect(frame).not.toBeNull();
    return frame!;
  });
  const token = decodeURIComponent(permissionFrame.src.split("#")[1] ?? "");
  expect(permissionFrame.allow).toBe("local-network-access");
  expect(sendMessage).toHaveBeenCalledWith({
    type: "AUTHORIZE_LOCAL_NETWORK_PROBE",
    token,
    host: "192.168.18.52",
    port: 42871
  });
  window.dispatchEvent(new MessageEvent("message", {
    source: permissionFrame.contentWindow,
    data: { type: "OTP_LOCAL_NETWORK_PROBE_RESULT", token, ok: true }
  }));
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "PAIR",
    host: "192.168.18.52",
    port: 42871,
    pairCode: "123456"
  })));
  const saveAddressButton = await vi.waitFor(() => {
    const button = [...shadow!.querySelectorAll("button")].find((item) => item.textContent === "保存新地址并重连");
    expect(button).not.toBeUndefined();
    return button!;
  });
  expect(saveAddressButton.hidden).toBe(true);
  const pairedAddress = shadow!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  pairedAddress.value = "192.168.18.53";
  pairedAddress.dispatchEvent(new Event("input"));
  expect(saveAddressButton.hidden).toBe(false);
  pairedAddress.value = "192.168.18.52";
  pairedAddress.dispatchEvent(new Event("input"));
  expect(saveAddressButton.hidden).toBe(true);
});
