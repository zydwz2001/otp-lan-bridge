import { describe, expect, it } from "vitest";
import { findVerifiedCandidate, pairedDeviceHostname, sameSubnetCandidates } from "../src/discovery";

describe("pairedDeviceHostname", () => {
  it("derives the same stable local hostname from a paired UUID", () => {
    expect(pairedDeviceHostname("CA8F82B4-12B4-4DC8-954F-52B50DB52EA1"))
      .toBe("otp-ca8f82b412b44dc8.local");
  });

  it("rejects identifiers too short to form a safe device hostname", () => {
    expect(pairedDeviceHostname("bad-id")).toBeUndefined();
  });
});

describe("sameSubnetCandidates", () => {
  it("tries nearby DHCP addresses first without retrying the stale host", () => {
    const candidates = sameSubnetCandidates("192.168.18.51");
    expect(candidates.slice(0, 6)).toEqual([
      "192.168.18.52",
      "192.168.18.50",
      "192.168.18.53",
      "192.168.18.49",
      "192.168.18.54",
      "192.168.18.48"
    ]);
    expect(candidates).toHaveLength(253);
    expect(new Set(candidates).size).toBe(253);
    expect(candidates).not.toContain("192.168.18.51");
    expect(candidates).not.toContain("192.168.18.0");
    expect(candidates).not.toContain("192.168.18.255");
  });

  it("rejects invalid addresses", () => {
    expect(sameSubnetCandidates("not-an-ip")).toEqual([]);
    expect(sameSubnetCandidates("192.168.1.255")).toEqual([]);
  });
});

describe("findVerifiedCandidate", () => {
  it("returns only the candidate accepted by the verifier", async () => {
    const found = await findVerifiedCandidate(
      ["192.168.18.52", "192.168.18.53", "192.168.18.54"],
      async (candidate) => candidate === "192.168.18.53",
      2
    );
    expect(found).toBe("192.168.18.53");
  });

  it("returns undefined when no paired phone verifies", async () => {
    await expect(findVerifiedCandidate(["192.168.18.52"], async () => false)).resolves.toBeUndefined();
  });

  it("stops outstanding probes as soon as the paired phone is verified", async () => {
    let cancelled = false;
    const found = await findVerifiedCandidate(
      ["192.168.18.52", "192.168.18.50"],
      (candidate, signal) => candidate === "192.168.18.52"
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            signal.addEventListener("abort", () => {
              cancelled = true;
              resolve(false);
            }, { once: true });
          }),
      2
    );

    expect(found).toBe("192.168.18.52");
    expect(cancelled).toBe(true);
  });
});
