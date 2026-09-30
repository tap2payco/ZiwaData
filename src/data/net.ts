/** Online/offline state. "Offline" can be simulated (?offline=1, or the header toggle in dev) for demos and tests. */
type Listener = () => void;
const listeners = new Set<Listener>();
let sim = false;

const q = () => {
  try { return new URLSearchParams(globalThis.location?.search ?? ''); } catch { return new URLSearchParams(); }
};
const store = () => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

export function initNet() {
  const params = q();
  if (params.get('offline') === '1') sim = true;
  else {
    try { sim = store()?.getItem('app.simOffline') === '1'; } catch { sim = false; }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => emit());
    window.addEventListener('offline', () => emit());
  }
}
const emit = () => listeners.forEach((l) => l());
export const subscribeNet = (l: Listener) => (listeners.add(l), () => void listeners.delete(l));
export const isSimOffline = () => sim;
export function setSimOffline(v: boolean) {
  sim = v;
  try { store()?.setItem('app.simOffline', v ? '1' : '0'); } catch { /* storage can be blocked */ }
  emit();
}
export const isOnline = () => !sim && (typeof navigator === 'undefined' || navigator.onLine !== false);
/** The offline toggle is shown in dev, or when the URL has ?dev=1 or ?offline=1. */
export function devToolsVisible(): boolean {
  const p = q();
  return !!(import.meta.env?.DEV) || p.get('dev') === '1' || p.has('offline');
}
