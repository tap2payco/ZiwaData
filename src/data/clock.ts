/** Clock with an optional `?now=2026-09-29T06:10:00Z` override so screenshots and demos are reproducible. Time still ticks. */
let offset = 0;
export function initClock() {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? '').get('now');
    const t = v ? Date.parse(v) : NaN;
    offset = Number.isFinite(t) ? t - Date.now() : 0;
  } catch { offset = 0; }
}
export const nowMs = () => Date.now() + offset;
