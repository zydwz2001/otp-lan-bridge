// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  decryptEnvelope,
  encryptEnvelope,
  hkdf,
  verifyHmac
} from "../src/crypto";

describe("encrypted protocol envelope", () => {
  it("round-trips an authenticated payload", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await encryptEnvelope(
      "ARM",
      "device-id",
      "session-id",
      1,
      1_786_400_000_000,
      { requestId: "request-id", expectedDigits: [4, 6] },
      key
    );
    await expect(decryptEnvelope(envelope, key)).resolves.toEqual({ requestId: "request-id", expectedDigits: [4, 6] });
  });

  it("rejects tampering with authenticated metadata", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await encryptEnvelope("PING", "device", "session", 7, Date.now(), { at: 1 }, key);
    envelope.seq = 8;
    await expect(decryptEnvelope(envelope, key)).rejects.toThrow();
  });

  it("derives deterministic HKDF output and verifies HMAC in constant work", async () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const salt = new Uint8Array([5, 6, 7, 8]);
    const first = await hkdf(input, salt, "bridge-test");
    const second = await hkdf(input, salt, "bridge-test");
    expect(bytesToBase64(first)).toBe(bytesToBase64(second));
    const keyCopy = new Uint8Array(first.byteLength);
    keyCopy.set(first);
    const subtleKey = await crypto.subtle.importKey("raw", keyCopy.buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const proof = await crypto.subtle.sign("HMAC", subtleKey, new TextEncoder().encode("proof"));
    expect(await verifyHmac(first, "proof", bytesToBase64(proof))).toBe(true);
    expect(await verifyHmac(first, "other", bytesToBase64(proof))).toBe(false);
  });
});
