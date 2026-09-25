// @vitest-environment node
import { expect, it } from "vitest";
import { BridgeFrameDecoder, encodeBridgeFrame, MAX_FRAME_BYTES } from "../src/bridge-transport";

it("decodes fragmented headers, split UTF-8 characters, and coalesced messages", () => {
  const messages = ['{"message":"连接手机"}', '{"type":"ACK"}'];
  const frames = messages.map(encodeBridgeFrame);
  const wire = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { wire.set(frame, offset); offset += frame.length; }
  const decoder = new BridgeFrameDecoder();
  const received: string[] = [];
  for (const byte of wire) received.push(...decoder.push(new Uint8Array([byte])));
  expect(received).toEqual(messages);
  expect(new BridgeFrameDecoder().push(wire)).toEqual(messages);
});

it("rejects empty, oversized, and malformed UTF-8 frames", () => {
  const header = new Uint8Array(4);
  expect(() => new BridgeFrameDecoder().push(header)).toThrow();
  new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
  expect(() => new BridgeFrameDecoder().push(header)).toThrow();
  expect(() => encodeBridgeFrame("x".repeat(MAX_FRAME_BYTES + 1))).toThrow();
  expect(() => new BridgeFrameDecoder().push(new Uint8Array([0, 0, 0, 1, 255]))).toThrow();
});
