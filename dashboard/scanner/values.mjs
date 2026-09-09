// Scalar parsers shared by the scanner modules. They live outside risk.mjs so
// evidence builders can reuse the exact same coercion rules without importing
// the risk evaluator itself. risk.mjs re-exports them for existing callers.
export const number = (v) =>
  !['number', 'string'].includes(typeof v) ||
  (typeof v === 'string' && v.trim() === '') ||
  !Number.isFinite(Number(v))
    ? null
    : Number(v);
export function flag(v) {
  return [true, 1, '1', 'true', 'yes'].includes(v)
    ? true
    : [false, 0, '0', 'false', 'no'].includes(v)
      ? false
      : null;
}
export function fraction(v) {
  const n = number(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}
export const arr = (v) => (Array.isArray(v) ? v : []);

// Sources disagree on the unit: GMGN reports creation time in Unix seconds,
// while DexScreener's pairCreatedAt and some Robinhood pair_created_at values
// are milliseconds. Anything past the year 2286 in seconds is read as millis,
// which also makes this a no-op when applied twice.
export const millis = (v) => {
  const n = number(v);
  if (n === null || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
};
