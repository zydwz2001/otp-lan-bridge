export function sameSubnetCandidates(previousHost: string): string[] {
  const parts = previousHost.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return [];
  const previousLast = parts[3]!;
  if (previousLast < 1 || previousLast > 254) return [];

  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const candidates: string[] = [];
  for (let distance = 1; distance < 254; distance += 1) {
    const higher = previousLast + distance;
    const lower = previousLast - distance;
    if (higher <= 254) candidates.push(`${prefix}.${higher}`);
    if (lower >= 1) candidates.push(`${prefix}.${lower}`);
  }
  return candidates;
}

export async function findVerifiedCandidate(
  candidates: string[],
  probe: (candidate: string, signal: AbortSignal) => Promise<boolean>,
  concurrency = 16
): Promise<string | undefined> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("并发数必须为正整数");
  if (candidates.length === 0) return undefined;

  return new Promise((resolve) => {
    const controller = new AbortController();
    let cursor = 0;
    let active = 0;
    let settled = false;

    const finish = (candidate?: string): void => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve(candidate);
    };

    const launch = (): void => {
      while (!settled && active < concurrency && cursor < candidates.length) {
        const candidate = candidates[cursor]!;
        cursor += 1;
        active += 1;
        void Promise.resolve(probe(candidate, controller.signal))
          .then((verified) => {
            active -= 1;
            if (verified) {
              finish(candidate);
              return;
            }
            if (cursor >= candidates.length && active === 0) finish();
            else launch();
          })
          .catch(() => {
            active -= 1;
            if (cursor >= candidates.length && active === 0) finish();
            else launch();
          });
      }
    };

    launch();
  });
}
