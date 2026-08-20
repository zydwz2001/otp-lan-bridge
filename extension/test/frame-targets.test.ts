import { describe, expect, it } from "vitest";
import { orderedFrameIds } from "../src/frame-targets";

describe("orderedFrameIds", () => {
  it("tries the last focused frame, then the main frame, then every other frame", () => {
    expect(orderedFrameIds(7, [{ frameId: 0 }, { frameId: 3 }, { frameId: 7 }])).toEqual([7, 0, 3]);
  });

  it("falls back to the main frame and removes duplicates", () => {
    expect(orderedFrameIds(undefined, [{ frameId: 0 }, { frameId: 2 }, { frameId: 2 }])).toEqual([0, 2]);
  });
});
