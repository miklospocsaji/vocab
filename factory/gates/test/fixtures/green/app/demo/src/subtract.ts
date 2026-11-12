export function subtract(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error("subtract takes finite numbers only");
  }
  return a - b;
}
