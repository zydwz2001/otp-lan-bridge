export function orderedFrameIds(
  preferredFrameId: number | undefined,
  frames: Array<{ frameId: number }>
): number[] {
  const ordered = [preferredFrameId, 0, ...frames.map((frame) => frame.frameId)];
  return ordered.filter((frameId, index): frameId is number =>
    Number.isInteger(frameId) && frameId! >= 0 && ordered.indexOf(frameId) === index
  );
}
