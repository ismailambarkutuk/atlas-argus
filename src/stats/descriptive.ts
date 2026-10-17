// Temel betimsel istatistikler (bağımlılıksız; inject.ts ve robustZ.ts ortak kullanır).

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mad(xs: number[], med = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - med)));
}
