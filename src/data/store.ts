import { useMemo, useSyncExternalStore } from 'react';
import { verifyChain, type ChainResult } from '../core/hashchain';
import type { Alert, Lang, Reading, ReadingDraft } from '../core/types';
import { httpApi } from './api';
import { openAppDb } from './db';
import { Engine, type ClientSettings, type Snapshot, type SyncSummary } from './engine';
import { nowMs } from './clock';
import { isOnline, isSimOffline, setSimOffline, subscribeNet } from './net';
import { loadLang, loadRole, loadTheme, saveLang, saveRole, saveTheme, applyTheme, type Role, type ThemeChoice } from './prefs';
import { buildFarmView, type FarmView } from './derived';
import { http } from './api';

export interface AppState {
  ready: boolean;
  error: string | null;
  snap: Snapshot | null;
  lang: Lang;
  theme: ThemeChoice;
  role: Role;
  online: boolean;
  simOffline: boolean;
  syncing: boolean;
  lastSync: SyncSummary | null;
  chains: Record<string, ChainResult>;
  now: number;
}

const initial = (): AppState => ({ ready: false, error: null, snap: null, lang: loadLang(), theme: loadTheme(), role: loadRole(), online: isOnline(), simOffline: isSimOffline(), syncing: false, lastSync: null, chains: {}, now: nowMs() });

class AppStore {
  state: AppState = initial();
  private listeners = new Set<() => void>();
  engine!: Engine;
  private started = false;

  subscribe = (l: () => void) => (this.listeners.add(l), () => void this.listeners.delete(l));
  getSnapshot = () => this.state;
  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  async start() {
    if (this.started) return;
    this.started = true;
    // The store is built at import time, before initNet()/initClock() run in main.tsx, so re-read them here.
    this.set({ online: isOnline(), simOffline: isSimOffline(), now: nowMs() });
    try {
      const db = await openAppDb();
      this.engine = new Engine({ db, api: httpApi, now: nowMs, isOnline });
      await this.engine.init();
      await this.reload();
      this.set({ ready: true });
      void this.verifyAll();
      subscribeNet(() => {
        this.set({ online: isOnline(), simOffline: isSimOffline() });
        if (isOnline()) void this.sync();
      });
      window.setInterval(() => this.set({ now: nowMs() }), 30_000);
      void this.sync();
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  async reload() {
    const snap = await this.engine.snapshot();
    this.set({ snap, now: nowMs() });
  }
  async verifyAll() {
    const snap = this.state.snap!;
    const chains: Record<string, ChainResult> = { ...this.state.chains };
    for (const f of snap.farms) chains[f.id] = await verifyChain(snap.readings.filter((r) => r.farmId === f.id));
    this.set({ chains });
  }
  private async verifyFarm(farmId: string) {
    const rs = this.state.snap!.readings.filter((r) => r.farmId === farmId);
    const c = await verifyChain(rs);
    this.set({ chains: { ...this.state.chains, [farmId]: c } });
  }

  setLang(l: Lang) { saveLang(l); document.documentElement.lang = l; this.set({ lang: l }); }
  setTheme(t: ThemeChoice) { saveTheme(t); this.set({ theme: t }); }
  setRole(r: Role) { saveRole(r); this.set({ role: r }); }
  setOffline(v: boolean) { setSimOffline(v); }

  /** Save readings on the phone first; sending is a separate, later step. */
  async record(farmId: string, drafts: ReadingDraft[]): Promise<{ saved: Reading[]; newAlerts: Alert[] }> {
    const before = this.currentAlerts(farmId);
    const saved = await this.engine.record(farmId, drafts);
    await this.reload();
    void this.verifyFarm(farmId);
    const after = this.currentAlerts(farmId);
    const beforeSev = new Map(before.map((a) => [a.id, a.severity]));
    const newAlerts = after.filter((a) => a.active && beforeSev.get(a.id) !== a.severity);
    // Queue an SMS for each new (or escalated) alert. Skipped when no number is saved on the server.
    const snap = this.state.snap!;
    if (snap.serverSettings?.hasPhone) {
      const farm = snap.farms.find((f) => f.id === farmId)!;
      for (const a of newAlerts) await this.engine.queueAlertSms(a, farm.cages.find((c) => c.id === a.cageId)?.number, snap.settings);
      if (newAlerts.length) await this.reload();
    }
    void this.sync();
    return { saved, newAlerts };
  }
  private currentAlerts(farmId: string): Alert[] {
    const snap = this.state.snap!;
    const farm = snap.farms.find((f) => f.id === farmId)!;
    return buildFarmView(farm, snap.readings, nowMs(), snap.forecast?.forecast ?? null, null).alerts;
  }

  async sync(): Promise<SyncSummary> {
    if (!this.engine) return { status: 'busy', sentReadings: 0, sentSms: 0, pulledInbound: 0 };
    this.set({ syncing: true });
    try {
      const r = await this.engine.sync();
      await this.reload();
      this.set({ lastSync: r });
      if (r.pulledInbound) void this.verifyAll();
      return r;
    } finally {
      this.set({ syncing: false });
    }
  }

  async saveSettings(s: ClientSettings) { await this.engine.saveSettings(s); await this.reload(); }
  async queueSmsForAlert(alert: Alert) {
    const snap = this.state.snap!;
    const farm = snap.farms.find((f) => f.id === alert.farmId)!;
    await this.engine.queueAlertSms(alert, farm.cages.find((c) => c.id === alert.cageId)?.number, { ...snap.settings, smsAlertTypes: { do: true, temp: true, ph: true, turnover: true, weather: true, stale: true } });
    await this.reload();
    void this.sync();
  }
  async queueTestSms() {
    const id = `test-${nowMs()}`;
    await this.engine.queueSms({ kind: 'test', lang: this.state.snap!.settings.smsLang, requestId: id });
    await this.reload();
    return this.sync();
  }
  async addLenderAction(farmId: string, action: 'hold' | 'release', reason: string) {
    await this.engine.addLenderAction({ farmId, action, reason, ts: new Date(nowMs()).toISOString() });
    await this.reload();
  }
  async resetDemo() {
    try { await http.post('/api/demo/reset'); } catch { /* offline: only this phone is reset */ }
    await this.engine.resetDemo();
    await this.reload();
    void this.verifyAll();
    void this.sync();
  }
}
export const store = new AppStore();
export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Farm views for every farm, recomputed when readings, forecast or the clock (per minute) change. */
export function useViews(): Record<string, FarmView> {
  const s = useApp();
  const snap = s.snap;
  const minute = Math.floor(s.now / 60_000);
  return useMemo(() => {
    const out: Record<string, FarmView> = {};
    if (!snap) return out;
    for (const f of snap.farms) out[f.id] = buildFarmView(f, snap.readings, s.now, snap.forecast?.forecast ?? null, s.chains[f.id] ?? null);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.readings, snap?.forecast, s.chains, minute]);
}
export { applyTheme };
