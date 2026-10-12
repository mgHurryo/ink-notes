export interface ScribblePosition { x: number; y: number }

/** Logical page pixels, independent of pen smoothing and viewport scale. */
export function scribbleLoops(cycles = 4, advance = 6, samplesPerCycle = 48): ScribblePosition[] {
  return Array.from({ length: cycles * samplesPerCycle + 1 }, (_, index) => {
    const progress = index / samplesPerCycle, angle = progress * Math.PI * 2;
    return { x: 35 + advance * progress + 20 * Math.cos(angle), y: 50 + 20 * Math.sin(angle) };
  });
}

export function scribbleWaves(cycles = 5, advance = 30, samplesPerCycle = 48): ScribblePosition[] {
  return Array.from({ length: cycles * samplesPerCycle + 1 }, (_, index) => {
    const progress = index / (cycles * samplesPerCycle);
    return { x: 30 + advance * progress, y: 50 + 20 * Math.sin(progress * cycles * Math.PI * 2) };
  });
}

export function rotateScribble(path: ScribblePosition[], degrees: number): ScribblePosition[] {
  const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return path.map(({ x, y }) => ({ x: 50 + (x - 50) * c - (y - 50) * s, y: 50 + (x - 50) * s + (y - 50) * c }));
}
