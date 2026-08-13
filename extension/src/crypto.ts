import type { Envelope } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomBase64(size: number): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(size)));
}

export async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer(data)));
}

export async function hmac(key: Uint8Array, value: string | Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, arrayBuffer(data)));
}

export async function hkdf(ikm: ArrayBuffer | Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", arrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: arrayBuffer(salt), info: arrayBuffer(encoder.encode(info)) },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function generatePairingKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return bytesToBase64(await crypto.subtle.exportKey("spki", key));
}

export async function derivePairingKey(
  privateKey: CryptoKey,
  serverPublicKey: string,
  pairCode: string
): Promise<Uint8Array> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    arrayBuffer(base64ToBytes(serverPublicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  return hkdf(shared, await sha256(pairCode), "wifi-otp-relay/pairing/v1");
}

export async function deriveSessionKey(
  pairingKey: Uint8Array,
  clientNonce: string,
  serverNonce: string,
  sessionId: string
): Promise<Uint8Array> {
  const client = base64ToBytes(clientNonce);
  const server = base64ToBytes(serverNonce);
  const salt = new Uint8Array(client.length + server.length);
  salt.set(client);
  salt.set(server, client.length);
  return hkdf(pairingKey, salt, `wifi-otp-relay/session/v1|${sessionId}`);
}

export async function verifyHmac(key: Uint8Array, value: string, expectedBase64: string): Promise<boolean> {
  const actual = await hmac(key, value);
  const expected = base64ToBytes(expectedBase64);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}

export async function encryptEnvelope(
  type: Envelope["type"],
  deviceId: string,
  sessionId: string,
  seq: number,
  timestamp: number,
  payload: unknown,
  sessionKey: Uint8Array
): Promise<Envelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", arrayBuffer(sessionKey), "AES-GCM", false, ["encrypt"]);
  const additionalData = encoder.encode(`1|${type}|${deviceId}|${sessionId}|${seq}|${timestamp}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(additionalData), tagLength: 128 },
    key,
    arrayBuffer(encoder.encode(JSON.stringify(payload)))
  );
  return {
    v: 1,
    type,
    deviceId,
    sessionId,
    seq,
    timestamp,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext)
  };
}

export async function decryptEnvelope(envelope: Envelope, sessionKey: Uint8Array): Promise<Record<string, unknown>> {
  if (envelope.v !== 1) throw new Error("不支持的协议版本");
  const nonce = base64ToBytes(envelope.nonce);
  if (nonce.length !== 12) throw new Error("随机数长度无效");
  const key = await crypto.subtle.importKey("raw", arrayBuffer(sessionKey), "AES-GCM", false, ["decrypt"]);
  const additionalData = encoder.encode(
    `1|${envelope.type}|${envelope.deviceId}|${envelope.sessionId}|${envelope.seq}|${envelope.timestamp}`
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(additionalData), tagLength: 128 },
    key,
    arrayBuffer(base64ToBytes(envelope.ciphertext))
  );
  return JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
}

function arrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
