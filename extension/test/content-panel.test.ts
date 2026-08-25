import { expect, it, vi } from "vitest";

it("opens phone and pairing settings inside the floating panel", async () => {
  let shadow: ShadowRoot | undefined;
  const nativeAttachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
    shadow = nativeAttachShadow.call(this, { mode: "open" });
    return shadow;
  });
  vi.spyOn(window, "setInterval").mockReturnValue(1);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });

  const openOptionsPage = vi.fn();
  const runtimeListeners = new Set<(message: Record<string, unknown>) => unknown>();
  let paired = false;
  let savedHost = "";
  let savedPort = 0;
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === "GET_CONTENT_INIT") {
      return {
        ok: true,
        allowed: true,
        soundEnabled: true,
        position: { x: 72, y: 120, collapsed: false },
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
      onMessage: {
        addListener: vi.fn((listener: (message: Record<string, unknown>) => unknown) => runtimeListeners.add(listener)),
        removeListener: vi.fn((listener: (message: Record<string, unknown>) => unknown) => runtimeListeners.delete(listener))
      },
      sendMessage,
      openOptionsPage,
      getURL: (path: string) => `chrome-extension://test-id/${path}`
    }
  });

  await import("../src/content");
  await vi.waitFor(() => expect(shadow?.querySelector(".settings")).not.toBeNull());
  expect((shadow!.host as HTMLElement).style.left).toBe("72px");
  expect((shadow!.host as HTMLElement).style.top).toBe("120px");
  const overlappingInput = document.createElement("input");
  vi.spyOn(overlappingInput, "getBoundingClientRect").mockReturnValue(new DOMRect(72, 120, 100, 30));
  vi.spyOn(shadow!.host, "getBoundingClientRect").mockReturnValue(new DOMRect(72, 120, 244, 136));
  document.body.append(overlappingInput);
  overlappingInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect((shadow!.host as HTMLElement).style.left).toBe("72px");
  expect((shadow!.host as HTMLElement).style.top).toBe("120px");
  expect((shadow!.host as HTMLElement).style.right).toBe("auto");
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

  const collapseButton = shadow!.querySelector(".collapse") as HTMLButtonElement;
  collapseButton.click();
  expect((shadow!.host as HTMLElement).style.width).toBe("132px");
  expect(shadow!.querySelector(".panel")?.classList.contains("collapsed")).toBe(true);
  expect(shadow!.querySelector(".title")?.textContent).toBe("验证码传递");
  (shadow!.querySelector(".header") as HTMLElement).click();
  expect((shadow!.host as HTMLElement).style.width).toBe("244px");
  expect(shadow!.querySelector(".panel")?.classList.contains("collapsed")).toBe(false);

  const address = shadow!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const pairCode = shadow!.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
  address.value = "192.168.18.52";
  port.value = "42871";
  pairCode.value = "123456";
  const pairButton = [...shadow!.querySelectorAll("button")].find((button) => button.textContent === "配对手机")!;
  pairButton.click();
  const authorizationCall = await vi.waitFor(() => {
    const call = sendMessage.mock.calls.find(([message]) => message.type === "AUTHORIZE_LOCAL_NETWORK_PROBE");
    expect(call).not.toBeUndefined();
    return call![0];
  });
  const token = String(authorizationCall.token);
  expect(sendMessage).toHaveBeenCalledWith({
    type: "AUTHORIZE_LOCAL_NETWORK_PROBE",
    token,
    host: "192.168.18.52",
    port: 42871
  });
  for (const listener of [...runtimeListeners]) {
    listener({ type: "LOCAL_NETWORK_PROBE_RESULT", token, probeOk: true });
  }
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "PAIR",
    host: "192.168.18.52",
    port: 42871,
    pairCode: "123456"
  })));
  const reconnectButton = await vi.waitFor(() => {
    const button = [...shadow!.querySelectorAll("button")].find((item) => item.textContent === "重新连接");
    expect(button).not.toBeUndefined();
    return button!;
  });
  const pairedAddress = shadow!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  pairedAddress.value = "192.168.18.53";
  pairedAddress.dispatchEvent(new Event("input"));
  expect(reconnectButton.textContent).toBe("保存新地址并重连");
  reconnectButton.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
    type: "INLINE_SAVE_ADDRESS",
    host: "192.168.18.53",
    port: 42871
  }));
  const retryButton = await vi.waitFor(() => {
    const button = [...shadow!.querySelectorAll("button")].find((item) => item.textContent === "重新连接");
    expect(button).not.toBeUndefined();
    return button!;
  });
  retryButton.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "RECONNECT" }));

  (shadow!.querySelector(".settings") as HTMLButtonElement).click();
  const codeExpiresAt = Date.now() + 5 * 60 * 1000;
  for (const listener of [...runtimeListeners]) {
    listener({
      type: "UI_STATE",
      state: {
        connection: "online",
        waitState: "CODE_READY",
        maskedPhone: "138****8000",
        code: "483921",
        codeExpiresAt,
        waitExpiresAt: codeExpiresAt,
        sourceAppLabel: "短信"
      }
    });
  }
  await vi.waitFor(() => expect(shadow!.querySelector(".code")?.textContent).toBe("483921"));
  const backToFill = [...shadow!.querySelectorAll("button")].find((button) => button.textContent === "返回填充")!;
  backToFill.click();
  expect(shadow!.querySelector(".code")).toBeNull();
  expect([...shadow!.querySelectorAll("button")].some((button) => button.textContent?.startsWith("查看验证码（"))).toBe(true);
  expect((shadow!.querySelector("main .primary") as HTMLButtonElement).textContent).toBe("点击手机号输入框，一键填充并等待");
  const viewCode = [...shadow!.querySelectorAll("button")].find((button) => button.textContent?.startsWith("查看验证码（"))!;
  viewCode.click();
  expect(shadow!.querySelector(".code")?.textContent).toBe("483921");

  sendMessage.mockImplementationOnce(() => {
    throw new Error("Extension context invalidated.");
  });
  const staleContextInput = document.createElement("input");
  document.body.append(staleContextInput);
  expect(() => staleContextInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))).not.toThrow();
});
