import { ArrowLeft, CircleCheck, Printer, Send, ShieldCheck, Thermometer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DEMO_BUILD, RULES } from '../core/config';
import { num } from '../core/format';
import { classifyDo, classifyKind } from '../core/rules';
import type { Alert, IncidentType, Kind, Reading, ReadingDraft, Status } from '../core/types';
import { nowMs } from '../data/clock';
import type { CageView, FarmView } from '../data/derived';
import { store, useApp, useViews } from '../data/store';
import { useT, type T } from '../i18n';
import { href, navigate } from '../router';
import { SourceTag, StatusBadge, DemoChip, useFmt, StatusIcon } from '../ui/bits';
import { ScoreRing, TrendChart } from '../ui/charts';
import { Segmented, Stepper } from '../ui/controls';
import { AlertCard, Bankability, Card, ChainLine, DeliveryChip, OfflineBanner, PageHeader, ReadingRow, ScorePanel, SectionTitle, SyncBar, adviceText, cageLabel, readingValue, noteText, SmsChip } from '../ui/panels';

const FARM = 'farm-demo';
function useFarm(): FarmView | null {
  const v = useViews();
  return v[FARM] ?? null;
}

// ------------------------------------------------------------------ small shared pieces
export function MeasureCell({ label, r, now, dp = 1 }: { label: string; r: Reading | null; now: number; dp?: number }) {
  const t = useT();
  const f = useFmt(now);
  return (
    <div className="measure">
      <div className="measure__label">{label}</div>
      {r ? (
        <>
          <div className="measure__val">{num(r.value as number, dp)} <span className="measure__unit">{r.unit === 'pH' ? '' : r.unit}</span></div>
          <SourceTag source={r.source} via={r.via} attested={r.attested} />
          <div className="note-small">{f.age(r.ts)}</div>
        </>
      ) : (
        <>
          <div className="measure__val measure__val--none">{'—'}</div>
          <div className="note-small">{t('status.none')}</div>
        </>
      )}
    </div>
  );
}
function feedText(t: T, level: CageView['feeding']) {
  return level === 'half' ? t('feed.half') : level === 'pause' ? t('feed.pause', { r: RULES.feeding.resumeDo.toFixed(1) }) : level === 'secure_pause' ? t('feed.secure') : t('feed.normal');
}
export const Thresholds = () => {
  const t = useT();
  return <p className="note-small">{t('rules.doDefaults', { ok: RULES.do.okMin.toFixed(1), crit: RULES.do.criticalBelow.toFixed(1) })} {t('demo.defaultNote')}</p>;
};

// ------------------------------------------------------------------ Home
export function HomeScreen() {
  const s = useApp();
  const t = useT();
  const v = useFarm();
  const f = useFmt(s.now);
  if (!v) return null;
  const anyReading = v.cages.some((c) => c.lastAny);
  const attention = v.needAttention;
  const status: Status = !anyReading ? 'none' : attention === 0 ? 'ok' : v.worstStatus;
  const line = !anyReading ? t('home.noReadings') : attention === 0 ? t('home.allOk') : t('home.attention', { n: attention });
  const low = v.lowest;
  const lowStatus = low ? classifyDo(low.do!.value as number) : 'none';
  const shown = v.active.slice(0, 3);
  const cageOf = (a: Alert) => v.farm.cages.find((c) => c.id === a.cageId);
  return (
    <div className="screen">
      <PageHeader title={<span className="status-line"><StatusIcon status={status} size={28} /> {line}</span>} sub={<span>{v.farm.name} <DemoChip /></span>} />
      <OfflineBanner />
      <div className="home-grid">
        <div className="stack">
          <Card className="hero">
            <p className="hero__lead" id="hero-lead">{t('home.doIs')}</p>
            <div className="hero__fig" aria-labelledby="hero-lead">
              <span className="hero__num">{low ? num(low.do!.value as number, 1) : '—'}</span>
              <span className="hero__unit">{low ? 'mg/L' : t('status.none')}</span>
            </div>
            {low ? (
              <>
                <div className="hero__meta">
                  <StatusBadge status={lowStatus} />
                  <span>{t('home.lowestOf', { c: low.cage.number })}</span>
                </div>
                <div className="hero__meta">
                  <SourceTag source={low.do!.source} via={low.do!.via} />
                  <span className="note-small">{f.age(low.do!.ts)}</span>
                  <DemoChip />
                </div>
                {low.feeding !== 'normal' && <p className="hero__feed"><strong>{t('feed.label')}</strong> {feedText(t, low.feeding)}</p>}
              </>
            ) : (
              <p className="note-small">{t('home.noDo')}</p>
            )}
          </Card>

          <section aria-labelledby="alerts-h">
            <SectionTitle right={<a className="link" href={href('farmer', 'alerts')}>{t('home.allAlerts')}</a>}><span id="alerts-h">{t('home.activeAlerts')}</span></SectionTitle>
            {shown.length === 0 ? (
              <Card className="empty-row"><CircleCheck className="bw-icon" aria-hidden="true" /> {t('home.noAlerts')}</Card>
            ) : (
              <div className="stack">{shown.map((a) => <AlertCard key={a.id} alert={a} cage={cageOf(a)} compact />)}</div>
            )}
            {v.active.length > 3 && <p className="note-small">{t('home.moreAlerts', { n: v.active.length - 3 })}</p>}
          </section>
        </div>

        <div className="stack">
          <a className="bw-btn bw-btn--lg bw-btn--full" href={href('farmer', 'record')}>{t('home.recordToday')}</a>
          <Card className="mini-score">
            <a className="mini-score__link" href={href('farmer', 'score')}>
              <ScoreRing score={v.score.total} size={96} showOf={false} label={t('score.ringLabel', { n: v.score.total })} />
              <div>
                <div className="subhead">{t('score.title')}</div>
                <div className="note-small">{t('score.ofHundred', { n: v.score.total })}</div>
                <div className="note-small">{t('score.rulesNotAiShort')}</div>
              </div>
            </a>
          </Card>
          <Card className="kpi">
            <div className="sc-stat__label">{t('kpi.daysLost')}</div>
            <div className="kpi__val">{v.daysLost.count} <span className="measure__unit">{t('kpi.days')}</span></div>
            <p className="note-small">{t('kpi.daysLostNote')}</p>
          </Card>
          <SyncBar />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Cages
export function CagesScreen() {
  const s = useApp();
  const t = useT();
  const v = useFarm();
  if (!v) return null;
  return (
    <div className="screen">
      <PageHeader title={t('cages.title')} sub={<span>{v.farm.name} <DemoChip /></span>} />
      <OfflineBanner />
      <ul className="cage-grid">
        {v.cages.map((c) => (
          <li key={c.cage.id}>
            <a className="bw-card cage-card" href={href('farmer', 'cages', c.cage.id)} aria-label={t('cages.open', { c: c.cage.number })}>
              <div className="cage-card__head">
                <span className="subhead">{cageLabel(t, c.cage)}</span>
                <StatusBadge status={c.status} />
              </div>
              <div className="measure-row">
                <MeasureCell label={t('kind.do.short')} r={c.do} now={s.now} />
                <MeasureCell label={t('kind.temp.short')} r={c.temp} now={s.now} />
                <MeasureCell label={t('kind.ph.short')} r={c.ph} now={s.now} />
              </div>
              {!c.cage.sensor && <p className="note-small">{c.lastAny ? t('cages.manualOnly') : t('cages.noData')}</p>}
              {c.stale && <p className="note-small stale"><StatusIcon status="watch" /> {t('cages.stale')}</p>}
              <DemoChip />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DepthPair({ c }: { c: CageView }) {
  const t = useT();
  if (!c.cage.depthProbe) {
    return (
      <Card well>
        <h3 className="subhead">{t('depth.title')}</h3>
        <p><strong>{t('depth.noProbe')}</strong></p>
        <p className="note-small">{t('depth.noProbeWhy')}</p>
      </Card>
    );
  }
  const sf = c.temp?.value as number | undefined;
  const dp = c.deep?.value as number | undefined;
  const scale = (v: number) => `${Math.max(4, Math.min(100, ((v - 15) / 20) * 100))}%`;
  return (
    <Card>
      <div className="depth-head"><h3 className="subhead">{t('depth.title')}</h3><StatusBadge status={c.turnover.status} /></div>
      {sf !== undefined && dp !== undefined ? (
        <>
          <div className="depth-bars" role="group" aria-label={t('depth.title')}>
            <div className="depth-bar"><span>{t('depth.surface')}</span><div className="depth-bar__track"><i style={{ width: scale(sf) }} /></div><strong>{num(sf)} {'°C'}</strong></div>
            <div className="depth-bar"><span>{t('depth.deep')}</span><div className="depth-bar__track"><i className="deep" style={{ width: scale(dp) }} /></div><strong>{num(dp)} {'°C'}</strong></div>
          </div>
          <p><strong>{t('depth.diff', { d: num(c.turnover.deltaC ?? sf - dp) })}</strong> {t('depth.limit', { lim: RULES.turnover.deltaC.toFixed(1) })}</p>
          <p className="note-small">{c.turnover.status === 'ok' ? t('depth.clear') : t('depth.risk')} {t('demo.defaultNote')}</p>
        </>
      ) : (
        <p className="note-small">{t('depth.noData')}</p>
      )}
    </Card>
  );
}

export function CageDetailScreen({ cageId }: { cageId: string }) {
  const s = useApp();
  const t = useT();
  const f = useFmt(s.now);
  const v = useFarm();
  const c = v?.cages.find((x) => x.cage.id === cageId);
  const points = useMemo(() => (c?.readings ?? []).filter((r) => r.kind === 'do' && typeof r.value === 'number').map((r) => ({ ts: Date.parse(r.ts), v: r.value as number, manual: r.source === 'manual' })), [c?.readings]);
  if (!v || !c) return <div className="screen"><PageHeader title={t('cages.title')} /></div>;
  const incidents = c.readings.filter((r) => r.kind === 'incident').sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const recent = c.readings.filter((r) => r.kind !== 'incident').slice(-10).reverse();
  return (
    <div className="screen">
      <PageHeader
        back={<a className="back-link" href={href('farmer', 'cages')}><ArrowLeft className="bw-icon" aria-hidden="true" /> {t('cages.title')}</a>}
        title={cageLabel(t, c.cage)}
        sub={<span>{t(c.cage.sensor ? 'cage.sensorCage' : 'cage.manualCage')} <DemoChip /></span>}
        right={<StatusBadge status={c.status} />}
      />
      <OfflineBanner />
      <div className="detail-grid">
        <div className="stack">
          <Card>
            <div className="measure-row">
              <MeasureCell label={t('kind.do')} r={c.do} now={s.now} />
              <MeasureCell label={t('kind.temp')} r={c.temp} now={s.now} />
              <MeasureCell label={t('kind.ph')} r={c.ph} now={s.now} />
            </div>
            <p className="feed-line"><strong>{t('feed.label')}</strong> {feedText(t, c.feeding)}</p>
            <p className="note-small">{t('feed.guidanceNote')}</p>
          </Card>
          <Card>
            <h3 className="subhead">{t('chart.title7')}</h3>
            <TrendChart points={points} now={s.now} days={7} unit="mg/L" ariaLabel={t('chart.aria', { c: c.cage.number, n: points.length })}
              lines={[{ value: RULES.do.okMin, label: t('chart.watchBelow', { v: RULES.do.okMin.toFixed(1) }), tone: 'watch' }, { value: RULES.do.criticalBelow, label: t('chart.critBelow', { v: RULES.do.criticalBelow.toFixed(1) }), tone: 'critical' }]} />
            <p className="note-small">{t('chart.legend')} {t('demo.defaultNote')}</p>
            <DemoChip />
          </Card>
          {c.active.length > 0 && (
            <div className="stack">
              <SectionTitle>{t('home.activeAlerts')}</SectionTitle>
              {c.active.map((a) => <AlertCard key={a.id} alert={a} cage={c.cage} compact />)}
            </div>
          )}
        </div>
        <div className="stack">
          <DepthPair c={c} />
          <Card>
            <h3 className="subhead">{t('incidents.title')}</h3>
            <p className="note-small">{t('incidents.note')}</p>
            {incidents.length === 0 ? <p>{t('incidents.none')}</p> : (
              <ul className="reading-list">
                {incidents.map((r) => (
                  <li key={r.id} className="reading-row">
                    <div className="reading-row__main"><span className="reading-row__kind">{t(`incident.${r.value}` as any)}</span><span className="note-small">{f.date(Date.parse(r.ts))}</span></div>
                    {r.note && <div>{noteText(r.note, t)}</div>}
                    <div className="reading-row__meta"><SourceTag source={r.source} via={r.via} />{r.demo && <DemoChip />}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h3 className="subhead">{t('cage.recent')}</h3>
            <ul className="reading-list">{recent.map((r) => <ReadingRow key={r.id} r={r} now={s.now} />)}</ul>
            {recent.length === 0 && <p>{t('status.none')}</p>}
          </Card>
          <a className="bw-btn bw-btn--lg bw-btn--full" href={href('farmer', 'record', c.cage.id)}>{t('home.recordToday')}</a>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Record
type FieldKey = 'do' | 'temp' | 'ph' | 'feed' | 'dead';
const FIELDS: { key: FieldKey; kind: Kind; unit: string; step: number; min: number; max: number; start: number; decimals: number }[] = [
  { key: 'do', kind: 'do', unit: 'mg/L', step: 0.1, min: 0, max: 20, start: 6.0, decimals: 1 },
  { key: 'temp', kind: 'temp', unit: '°C', step: 0.1, min: 10, max: 40, start: 27.0, decimals: 1 },
  { key: 'ph', kind: 'ph', unit: 'pH', step: 0.1, min: 4, max: 11, start: 7.5, decimals: 1 },
  { key: 'feed', kind: 'feed', unit: 'kg', step: 0.5, min: 0, max: 5000, start: 0, decimals: 1 },
  { key: 'dead', kind: 'mortality', unit: 'fish', step: 1, min: 0, max: 100000, start: 0, decimals: 0 },
];
const INCIDENTS: (IncidentType | 'none')[] = ['none', 'predator', 'poaching', 'storm', 'disease', 'other'];

export function validateRecord(t: T, vals: Record<FieldKey, string>, incident: string, note: string): { errors: Partial<Record<FieldKey | 'note' | 'form', string>>; parsed: Partial<Record<FieldKey, number>> } {
  const errors: Partial<Record<FieldKey | 'note' | 'form', string>> = {};
  const parsed: Partial<Record<FieldKey, number>> = {};
  for (const fd of FIELDS) {
    const raw = vals[fd.key].trim();
    if (raw === '') continue;
    const n = Number(raw.replace(',', '.'));
    if (!Number.isFinite(n) || !/^\d+([.,]\d+)?$/.test(raw)) errors[fd.key] = t('record.err.number');
    else if (n < fd.min || n > fd.max || (fd.key === 'dead' && !Number.isInteger(n))) errors[fd.key] = t(`record.err.${fd.key}` as any, { min: fd.min, max: fd.max });
    else parsed[fd.key] = n;
  }
  if (incident === 'other' && !note.trim()) errors.note = t('record.err.note');
  if (!Object.keys(errors).length && !Object.keys(parsed).length && incident === 'none') errors.form = t('record.err.nothing');
  return { errors, parsed };
}

export function RecordScreen({ initialCage }: { initialCage?: string }) {
  const s = useApp();
  const t = useT();
  const v = useFarm();
  const [cageId, setCageId] = useState(initialCage ?? `${FARM}-c1`);
  const [vals, setVals] = useState<Record<FieldKey, string>>({ do: '', temp: '', ph: '', feed: '', dead: '' });
  const [incident, setIncident] = useState<string>('none');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldKey | 'note' | 'form', string>>>({});
  const [saved, setSaved] = useState<{ saved: Reading[]; newAlerts: Alert[]; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const f = useFmt(s.now);
  if (!v) return null;
  const cage = v.farm.cages.find((c) => c.id === cageId)!;
  const pending = (s.snap?.pending.readings ?? 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { errors: errs, parsed } = validateRecord(t, vals, incident, note);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const ts = new Date(nowMs()).toISOString();
    const base = { cageId, farmId: FARM, ts, source: 'manual' as const, via: 'app' as const, demo: DEMO_BUILD };
    const drafts: ReadingDraft[] = [];
    for (const fd of FIELDS) if (parsed[fd.key] !== undefined) drafts.push({ ...base, kind: fd.kind, value: parsed[fd.key]!, unit: fd.unit });
    if (incident !== 'none') drafts.push({ ...base, kind: 'incident', value: incident, unit: '', note: note.trim() || undefined });
    setBusy(true);
    try {
      const r = await store.record(FARM, drafts);
      setSaved({ ...r, at: nowMs() });
    } finally {
      setBusy(false);
    }
  };
  const reset = () => { setSaved(null); setVals({ do: '', temp: '', ph: '', feed: '', dead: '' }); setIncident('none'); setNote(''); setErrors({}); };

  if (saved) {
    const doR = saved.saved.find((r) => r.kind === 'do');
    const st = doR ? classifyDo(doR.value as number) : 'none';
    return (
      <div className="screen">
        <PageHeader title={t('record.savedTitle')} />
        <OfflineBanner />
        <Card className="saved-card" >
          <p className="saved-line"><CircleCheck className="bw-icon" aria-hidden="true" /> <strong>{t('record.savedPhone')}</strong> {!s.online ? t('record.willSend') : pending > 0 ? t('record.sending') : t('record.sent', { when: f.time(s.snap?.lastSyncAt ? Date.parse(s.snap.lastSyncAt) : saved.at) })}</p>
          {doR && <p className="saved-say">{t('record.doIs', { v: num(doR.value as number), c: cage.number })} <StatusBadge status={st} /></p>}
          <ul className="plain-list">{saved.saved.map((r) => <li key={r.id}>{t(`kind.${r.kind}` as any)}: <strong>{readingValue(r, t)}</strong></li>)}</ul>
          {saved.newAlerts.length > 0 && (
            <div className="stack">
              <SectionTitle>{t('record.newAlerts')}</SectionTitle>
              {saved.newAlerts.map((a) => <AlertCard key={a.id} alert={a} cage={v.farm.cages.find((c) => c.id === a.cageId)} compact />)}
            </div>
          )}
          <div className="btn-row">
            <button type="button" className="bw-btn bw-btn--lg" onClick={reset}>{t('record.another')}</button>
            <a className="bw-btn bw-btn--lg bw-btn--secondary" href={href('farmer', 'home')}>{t('nav.home')}</a>
          </div>
        </Card>
        <SyncBar />
      </div>
    );
  }
  const errList = Object.entries(errors).filter(([, m]) => !!m);
  return (
    <div className="screen">
      <PageHeader title={t('record.title')} sub={<span>{v.farm.name} <DemoChip /></span>} />
      <OfflineBanner />
      <form onSubmit={submit} noValidate className="record-form">
        {errList.length > 0 && (
          <div className="error-summary" role="alert">
            <strong>{t('record.fixThese')}</strong>
            <ul>{errList.map(([k, m]) => <li key={k}>{m}</li>)}</ul>
          </div>
        )}
        <Card>
          <label className="bw-field-label" htmlFor="cage">{t('record.cage')}</label>
          <select id="cage" className="select" value={cageId} onChange={(e) => setCageId(e.target.value)}>
            {v.farm.cages.map((c) => <option key={c.id} value={c.id}>{cageLabel(t, c)}</option>)}
          </select>
          <p className="note-small">{t('record.cageHint')}</p>
        </Card>
        <div className="record-grid">
          {FIELDS.map((fd) => (
            <Card key={fd.key}>
              <Stepper label={t(`record.f.${fd.key}` as any)} unit={fd.unit === 'pH' ? 'pH' : fd.unit === 'fish' ? t('record.fish') : fd.unit} value={vals[fd.key]} onChange={(x) => setVals({ ...vals, [fd.key]: x })}
                step={fd.step} min={fd.min} max={fd.max} start={fd.start} decimals={fd.decimals} error={errors[fd.key]} hint={t('record.range', { min: fd.min, max: fd.max })} />
            </Card>
          ))}
        </div>
        <Card>
          <div className="bw-field-label" id="inc-l">{t('record.incident')}</div>
          <div className="chip-group" role="radiogroup" aria-labelledby="inc-l">
            {INCIDENTS.map((i) => (
              <button key={i} type="button" role="radio" aria-checked={incident === i} className="chip-opt" onClick={() => setIncident(i)}>{t(`incident.${i}` as any)}</button>
            ))}
          </div>
          <p className="note-small">{t('record.incidentNote')}</p>
          {incident !== 'none' && (
            <>
              <label className="bw-field-label" htmlFor="inote">{t('record.note')}</label>
              <textarea id="inote" className="textarea" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={!!errors.note} />
              {errors.note && <div className="field-error" role="alert">{errors.note}</div>}
            </>
          )}
        </Card>
        <p className="note-small">{t('record.provenance')}</p>
        <button type="submit" className="bw-btn bw-btn--lg bw-btn--full" disabled={busy}>{t('record.save')}</button>
        <SyncBar />
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ Alerts
export function AlertsScreen() {
  const s = useApp();
  const t = useT();
  const v = useFarm();
  const [busy, setBusy] = useState(false);
  if (!v) return null;
  const snap = s.snap!;
  const hasPhone = !!snap.serverSettings?.hasPhone;
  const active = v.alerts.filter((a) => a.active);
  const cleared = v.alerts.filter((a) => !a.active);
  const test = snap.lastTestSms;
  const cageOf = (a: Alert) => v.farm.cages.find((c) => c.id === a.cageId);
  // Delivery reports are keyed by the requestId we sent under, not by the alert.
  const deliveryFor = (alertId: string) => {
    const requestId = snap.alertSms[alertId]?.requestId;
    return requestId ? snap.smsDelivery[requestId] : undefined;
  };
  const sendTest = async () => { setBusy(true); try { await store.queueTestSms(); } finally { setBusy(false); } };
  return (
    <div className="screen">
      <PageHeader title={t('alerts.title')} sub={<span>{t('alerts.sub')} <DemoChip /></span>} />
      <OfflineBanner />
      <div className="detail-grid">
        <div className="stack">
          <section>
            <SectionTitle>{t('alerts.active', { n: active.length })}</SectionTitle>
            {active.length === 0 ? <Card className="empty-row"><CircleCheck className="bw-icon" aria-hidden="true" /> {t('home.noAlerts')}</Card> : <div className="stack">{active.map((a) => <AlertCard key={a.id} alert={a} cage={cageOf(a)} sms={snap.alertSms[a.id]} delivery={deliveryFor(a.id)} canSend={hasPhone} />)}</div>}
          </section>
          <section>
            <SectionTitle>{t('alerts.cleared', { n: cleared.length })}</SectionTitle>
            <div className="stack">{cleared.map((a) => <AlertCard key={a.id} alert={a} cage={cageOf(a)} sms={snap.alertSms[a.id]} delivery={deliveryFor(a.id)} />)}</div>
          </section>
        </div>
        <div className="stack">
          <Card>
            <h3 className="subhead">{t('alerts.testTitle')}</h3>
            <p>{hasPhone ? t('alerts.testTo', { p: snap.serverSettings!.phoneMasked ?? '' }) : t('alerts.noPhone')}</p>
            {!hasPhone && <a className="bw-btn bw-btn--secondary" href={href('farmer', 'settings')}>{t('alerts.addPhone')}</a>}
            {hasPhone && <button type="button" className="bw-btn bw-btn--secondary" disabled={busy} onClick={() => void sendTest()}><Send className="bw-icon" aria-hidden="true" /> {t('alerts.sendTest')}</button>}
            {test && (
              <p className="note-small" role="status">
                <SmsChip state={test.state} error={test.error} />{' '}
                <DeliveryChip delivery={snap.smsDelivery[test.requestId]} sent={test.state === 'sent'} />
              </p>
            )}
            <p className="note-small">{t('sms.dryRunExplain')}</p>
            {test?.state === 'sent' && <p className="note-small">{t('sms.delivery.explain')}</p>}
          </Card>
          <Card well>
            <h3 className="subhead">{t('alerts.rulesTitle')}</h3>
            <p className="note-small">{t('alerts.rulesBody')} {t('demo.defaultNote')}</p>
            <p className="note-small">{t('feed.guidanceNote')}</p>
            <p className="note-small">{t('weather.note')}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Record score
export function ScoreScreen() {
  const t = useT();
  const s = useApp();
  const v = useFarm();
  const f = useFmt(s.now);
  if (!v) return null;
  const sc = v.score;
  return (
    <div className="screen">
      <PageHeader title={t('score.title')} sub={<span>{v.farm.name} <DemoChip /></span>} right={<a className="bw-btn bw-btn--secondary" href={href('farmer', 'pack')}><Printer className="bw-icon" aria-hidden="true" /> {t('pack.export')}</a>} />
      <OfflineBanner />
      <div className="detail-grid">
        <div className="stack">
          <Card>
            <ScorePanel view={v} />
          </Card>
          <Card>
            <h3 className="subhead">{t('score.howTitle')}</h3>
            <ul className="advice-list">{sc.advice.map((a, i) => <li key={i}>{adviceText(t, a, v)}</li>)}</ul>
          </Card>
        </div>
        <div className="stack">
          <Card>
            <h3 className="subhead">{t('score.tranche')}</h3>
            <p className="tranche-line">{sc.holdsTranche ? <StatusBadge status="watch" /> : <StatusBadge status="ok" />} {sc.holdsTranche ? t('score.holds') : t('score.meets')}</p>
            {sc.holdReasons.map((r) => <p key={r} className="note-small">{t(`hold.${r}` as any, { d: sc.daysSinceLast ? Math.floor(sc.daysSinceLast) : 0 })}</p>)}
            <p className="note-small">{t('tranche.rule')} {t('tranche.simulated')}</p>
          </Card>
          <Card>
            <h3 className="subhead">{t('chain.title')}</h3>
            <ChainLine view={v} long />
          </Card>
          <Card>
            <h3 className="subhead">{t('bank.title')}</h3>
            <p className="note-small">{t('bank.intro')}</p>
            <Bankability />
          </Card>
        </div>
      </div>
    </div>
  );
}
export { ShieldCheck, Thermometer, classifyKind };
