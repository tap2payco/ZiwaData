import { CheckCheck, CircleCheck, CircleDot, Circle, CircleX, CircleHelp, Clock, RefreshCw, WifiOff, Send, Loader } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { RULES } from '../core/config';
import { thousands, num } from '../core/format';
import type { Alert, Cage, Reading, SmsState } from '../core/types';
import type { AlertSms } from '../data/db';
import type { SmsDelivery } from '../data/api';
import { useApp, store } from '../data/store';
import type { FarmView } from '../data/derived';
import { useLang, useT, type T } from '../i18n';
import { SourceTag, StatusBadge, DemoChip, useFmt } from './bits';
import { Collapse } from './controls';
import { ScoreRing } from './charts';
import type { ScorePart } from '../core/score';

// ------------------------------------------------------------------ Page furniture
export function PageHeader({ title, sub, right, back }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; back?: ReactNode }) {
  return (
    <header className="page-head">
      {back}
      <div className="page-head__row">
        <div className="page-head__text">
          <h1 className="page-title">{title}</h1>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
        {right && <div className="page-head__right">{right}</div>}
      </div>
    </header>
  );
}
export const Card = ({ children, className = '', well = false }: { children: ReactNode; className?: string; well?: boolean }) => <section className={`bw-card card ${well ? 'bw-card--well' : ''} ${className}`}>{children}</section>;
export const SectionTitle = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="section-title">
    <h2>{children}</h2>
    {right}
  </div>
);

export function OfflineBanner() {
  const s = useApp();
  const t = useT();
  if (s.online) return null;
  return (
    <div className="bw-offline" role="status">
      <WifiOff className="bw-icon" aria-hidden="true" />
      <div>
        <p className="bw-offline__title">{t('offline.title')}</p>
        <p>{t('offline.body')}</p>
      </div>
    </div>
  );
}

export function SyncBar() {
  const s = useApp();
  const t = useT();
  const f = useFmt(s.now);
  const pending = (s.snap?.pending.readings ?? 0) + (s.snap?.pending.sms ?? 0);
  const last = s.snap?.lastSyncAt ? Date.parse(s.snap.lastSyncAt) : null;
  const unreachable = s.online && s.lastSync && (s.lastSync.status === 'unreachable');
  const conflicts = s.lastSync?.conflicts ?? 0;
  return (
    <>
    <button type="button" className={`bw-sync${!s.online ? ' bw-sync--offline' : ''}`} onClick={() => void store.sync()} disabled={s.syncing || !s.online} aria-label={t('sync.now')}>
      <span className="bw-sync__main">
        {s.syncing ? <Loader className="bw-icon bw-spin" aria-hidden="true" /> : !s.online ? <WifiOff className="bw-icon" aria-hidden="true" /> : pending ? <RefreshCw className="bw-icon" aria-hidden="true" /> : <CheckCheck className="bw-icon" aria-hidden="true" />}
        {!s.online ? t('sync.offline') : unreachable ? t('sync.unreachable') : pending ? t('sync.pending') : t('sync.synced')}
        {pending > 0 && <span className="bw-count">{pending}</span>}
      </span>
      <span className="bw-sync__meta">{s.online ? (last ? `${f.time(last)}` : '') : ''}{s.online && pending > 0 ? ` · ${t('sync.now')}` : ''}</span>
    </button>
    {conflicts > 0 && <p className="note-small field-error" role="alert">{t('sync.conflict', { n: conflicts })}</p>}
    </>
  );
}

// ------------------------------------------------------------------ Alerts
export const cageLabel = (t: T, cage: Cage | undefined | null) => (cage ? t('cage.name', { n: cage.number }) : t('alert.wholeFarm'));

export function alertText(a: Alert, t: T, cage?: Cage | null) {
  const c = cage?.number ?? 0;
  const p = a.params;
  const v = num(p.value, 1);
  const thr = num(p.threshold, 1);
  let rule = '';
  let title = '';
  let action = '';
  switch (a.rule) {
    case 'do':
      title = t('alert.title.do', { c });
      rule = a.severity === 'critical' ? t('alert.rule.do.critical', { v, thr }) : t('alert.rule.do.watch', { v, thr });
      action = a.severity === 'critical' ? t('action.pause', { r: RULES.feeding.resumeDo.toFixed(1) }) : t('action.half');
      break;
    case 'temp':
      title = t('alert.title.temp', { c });
      rule = p.limitKind === 'low' ? t('alert.rule.temp.low', { v, thr }) : t('alert.rule.temp.high', { v, thr });
      action = t('action.temp');
      break;
    case 'ph':
      title = t('alert.title.ph', { c });
      rule = p.limitKind === 'low' ? t('alert.rule.ph.low', { v, thr }) : t('alert.rule.ph.high', { v, thr });
      action = t('action.ph');
      break;
    case 'turnover':
      title = t('alert.title.turnover', { c });
      rule = a.severity === 'critical'
        ? t('alert.rule.turnover.critical', { d: num(p.deltaC, 1), lim: RULES.turnover.deltaC.toFixed(1), v, crit: RULES.turnover.criticalDo.toFixed(1) })
        : t('alert.rule.turnover.watch', { d: num(p.deltaC, 1), lim: RULES.turnover.deltaC.toFixed(1), drop: RULES.turnover.doDrop.toFixed(1) });
      action = t('action.pause', { r: RULES.feeding.resumeDo.toFixed(1) });
      break;
    case 'wind':
      title = t('alert.title.wind');
      rule = t('alert.rule.wind', { v: num(p.value, 0), thr: num(p.threshold, 0) });
      action = a.severity === 'critical' ? t('action.secure') : t('action.wind');
      break;
    case 'rain':
      title = t('alert.title.rain');
      rule = t('alert.rule.rain', { v: num(p.value, 0), thr: num(p.threshold, 0) });
      action = t('action.rain');
      break;
    case 'stale':
      title = t('alert.title.stale', { c });
      rule = t('alert.rule.stale', { h: num(p.hours, 0) });
      action = t('action.stale');
      break;
  }
  return { title, rule, action };
}

export function SmsChip({ state, error }: { state: SmsState | 'not_sent'; error?: string }) {
  const t = useT();
  const label = { queued: t('sms.state.queued'), sent: t('sms.state.sent'), failed: t('sms.state.failed'), dry_run: t('sms.state.dry_run'), not_sent: t('sms.state.not_sent') }[state];
  const extra = state === 'failed' && error === 'no_phone' ? t('sms.err.no_phone') : state === 'failed' && error === 'rate_limited' ? t('sms.err.rate_limited') : null;
  return (
    <span className="sms-chip" data-state={state}>
      <Send className="bw-icon" aria-hidden="true" /> {t('sms.label')}: <strong>{label}</strong>
      {extra && <span className="note-small"> {extra}</span>}
    </span>
  );
}

/**
 * What Beem said about delivery, AFTER the message was sent. Deliberately separate from SmsChip: "Sent" means
 * Beem accepted it, "Delivered" means it reached the handset. No report at all is shown as "No report yet",
 * never as delivered. Icon plus word plus colour, like every other state in this app.
 */
export function DeliveryChip({ delivery, sent }: { delivery?: SmsDelivery; sent: boolean }) {
  const t = useT();
  if (!sent) return null;
  const state = delivery?.state ?? 'none';
  const Icon = state === 'delivered' ? CheckCheck : state === 'failed' ? CircleX : state === 'pending' ? Clock : CircleHelp;
  const label = {
    delivered: t('sms.delivery.delivered'),
    failed: t('sms.delivery.failed'),
    pending: t('sms.delivery.pending'),
    unknown: t('sms.delivery.unknown'),
    none: t('sms.delivery.none'),
  }[state];
  return (
    <span className="sms-chip" data-delivery={state} title={delivery?.raw}>
      <Icon className="bw-icon" aria-hidden="true" /> {t('sms.delivery.label')}: <strong>{label}</strong>
    </span>
  );
}

export function AlertCard({ alert, cage, sms, delivery, canSend, compact = false }: { alert: Alert; cage?: Cage | null; sms?: AlertSms; delivery?: SmsDelivery; canSend?: boolean; compact?: boolean }) {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const x = alertText(alert, t, cage);
  const sev = alert.severity;
  return (
    <article className={`alert-card alert-card--${sev}${alert.active ? '' : ' alert-card--cleared'}`}>
      <div className="alert-card__top">
        <StatusBadge status={alert.active ? sev : 'ok'} />
        <h3 className="alert-card__title">{x.title}</h3>
      </div>
      <p className="alert-card__rule"><strong>{t('alert.ruleLabel')}</strong> {x.rule}</p>
      {!compact && (
        <>
          <p className="alert-card__action"><strong>{t('alert.actionLabel')}</strong> {alert.active ? x.action : t('alert.clearedNote')}</p>
          <p className="note-small">
            {t('alert.firstFired', { when: f.dateTime(Date.parse(alert.firstFiredAt)) })}
            {alert.clearedAt ? ` · ${t('alert.clearedAt', { when: f.dateTime(Date.parse(alert.clearedAt)) })}` : ''}
            {alert.peak === 'critical' && alert.severity === 'watch' ? ` · ${t('alert.peakCritical')}` : ''}
            {alert.unverified ? ` · ${t('alert.unverified')}` : ''}
          </p>
          <div className="alert-card__sms">
            <SmsChip state={sms?.state ?? 'not_sent'} error={sms?.error} />
            <DeliveryChip delivery={delivery} sent={sms?.state === 'sent'} />
            {alert.active && (!sms || sms.state === 'failed' || sms.state === 'dry_run') && canSend && (
              <button type="button" className="bw-btn bw-btn--secondary bw-btn--sm" onClick={() => void store.queueSmsForAlert(alert)}>
                {t('sms.sendThis')}
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

// ------------------------------------------------------------------ Readings
export const KIND_KEY = { do: 'kind.do', temp: 'kind.temp', temp_deep: 'kind.temp_deep', ph: 'kind.ph', feed: 'kind.feed', mortality: 'kind.mortality', incident: 'kind.incident' } as const;
export function readingValue(r: Reading, t: T): string {
  if (r.kind === 'incident') return t(`incident.${r.value}` as any);
  const dp = r.kind === 'mortality' ? 0 : r.kind === 'feed' ? 1 : 1;
  const unit = r.unit === 'pH' ? '' : r.unit === 'fish' ? t('record.fish') : r.unit;
  return `${num(r.value as number, dp)} ${unit}`.trim();
}
export function noteText(note: string | undefined, t: T): string {
  if (!note) return '';
  return note.startsWith('@') ? t(`note.${note.slice(1)}` as any) : note;
}
export function ReadingRow({ r, cage, now }: { r: Reading; cage?: Cage; now: number }) {
  const t = useT();
  const f = useFmt(now);
  return (
    <li className="reading-row">
      <div className="reading-row__main">
        <span className="reading-row__kind">{t(KIND_KEY[r.kind])}</span>
        <span className="reading-row__val">{readingValue(r, t)}</span>
      </div>
      <div className="reading-row__meta">
        {cage && <span>{cageLabel(t, cage)}</span>}
        <SourceTag source={r.source} via={r.via} attested={r.attested} />
        <span>{f.dateTime(Date.parse(r.ts))}</span>
        {r.demo && <DemoChip />}
      </div>
      {r.note && <div className="note-small">{noteText(r.note, t)}</div>}
    </li>
  );
}

// ------------------------------------------------------------------ Score
export function partName(t: T, id: ScorePart['id']) {
  return t(`score.part.${id}` as any);
}
function partDetail(p: ScorePart, t: T): string {
  const f = p.facts;
  switch (p.id) {
    case 'completeness': return t('score.detail.completeness', { days: f.days!, of: f.of! });
    case 'consistency': return t('score.detail.consistency', { gapCages: f.gapCages!, cages: f.cages!, bad: f.implausible! });
    case 'verification': return f.total ? t('score.detail.verification', { v: f.verified!, total: f.total!, att: f.attested! }) : t('score.detail.verification.none');
    case 'outcomes': {
      const doPart = f.doSharePct! < 0 ? t('score.detail.outcomes.noDo') : t('score.detail.outcomes.do', { pct: f.doSharePct! });
      const mort = f.mortalityReadings! === 0 ? t('score.detail.outcomes.noMort') : f.rising ? t('score.detail.outcomes.rising', { a: f.last15!, b: f.prev15! }) : t('score.detail.outcomes.steady', { a: f.last15!, b: f.prev15! });
      return `${doPart} ${mort}`;
    }
  }
}

function Evidence({ view, part }: { view: FarmView; part: ScorePart }) {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const byId = useMemo(() => new Map(view.readings.map((r) => [r.id, r])), [view.readings]);
  const cages = new Map(view.farm.cages.map((c) => [c.id, c]));
  const list = (ids: string[], max = 12) => {
    const rs = ids.map((i) => byId.get(i)).filter((r): r is Reading => !!r).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return (
      <>
        <ul className="reading-list">{rs.slice(0, max).map((r) => <ReadingRow key={r.id} r={r} cage={cages.get(r.cageId)} now={s.now} />)}</ul>
        {rs.length > max && <p className="note-small">{t('score.moreReadings', { n: rs.length - max })}</p>}
        {rs.length === 0 && <p className="note-small">{t('score.noneHere')}</p>}
      </>
    );
  };
  const e = part.evidence;
  return (
    <div className="evidence">
      {part.id === 'completeness' && (
        <>
          <h4>{t('score.ev.missingDays', { n: e.missingDays?.length ?? 0 })}</h4>
          <p className="note-small">{(e.missingDays ?? []).map((d) => f.date(Date.parse(d + 'T09:00:00Z'))).join(', ') || t('score.noneHere')}</p>
          <h4>{t('score.ev.firstOfDay', { n: e.primary.length })}</h4>
          {list(e.primary, 6)}
        </>
      )}
      {part.id === 'consistency' && (
        <>
          <h4>{t('score.ev.gaps')}</h4>
          {(e.gaps ?? []).length === 0 ? <p className="note-small">{t('score.noneHere')}</p> : (
            <ul className="plain-list">
              {(e.gaps ?? []).map((g, i) => (
                <li key={i}>{t('score.ev.gap', { c: cages.get(g.cageId)?.number ?? 0, d: Math.round(g.days) })} {g.toTs ? `(${f.date(Date.parse(g.fromTs))} → ${f.date(Date.parse(g.toTs))})` : `(${t('score.ev.gapOpen', { when: f.date(Date.parse(g.fromTs)) })})`}</li>
              ))}
            </ul>
          )}
          <h4>{t('score.ev.implausible', { n: e.secondary.length })}</h4>
          {list(e.secondary)}
        </>
      )}
      {part.id === 'verification' && (
        <>
          <h4>{t('score.ev.verified', { n: e.primary.length })}</h4>
          {list(e.primary, 8)}
          <h4>{t('score.ev.selfReported', { n: e.secondary.length })}</h4>
          {list(e.secondary, 8)}
        </>
      )}
      {part.id === 'outcomes' && (
        <>
          <h4>{t('score.ev.lowDo', { n: e.secondary.length })}</h4>
          {list(e.secondary, 8)}
          <h4>{t('score.ev.mortality', { n: e.extra?.length ?? 0 })}</h4>
          {list(e.extra ?? [], 6)}
        </>
      )}
    </div>
  );
}

export function adviceText(t: T, a: { key: string; params: Record<string, string | number> }, view: FarmView): string {
  const p = a.params;
  if (a.key === 'fix_gaps') {
    const c = view.farm.cages.find((x) => x.id === p.cageId);
    return t('advice.fix_gaps', { c: c?.number ?? 0, d: p.days as number });
  }
  return t(`advice.${a.key}` as any, p as any);
}

export function ScorePanel({ view, compact = false }: { view: FarmView; compact?: boolean }) {
  const t = useT();
  const sc = view.score;
  return (
    <div className="score-panel">
      <div className="score-panel__ring">
        <ScoreRing score={sc.total} label={t('score.ringLabel', { n: sc.total })} />
        <p className="note-small center">{t('score.rulesNotAi')}</p>
      </div>
      <ul className="bw-score__list score-panel__parts">
        {sc.parts.map((p) => (
          <li key={p.id} className="bw-score__item">
            <span className="bw-score__name">{partName(t, p.id)}</span>
            <span className="bw-score__pts">{p.points} / {p.max}</span>
            <span className="bw-score__bar" role="progressbar" aria-valuenow={p.points} aria-valuemin={0} aria-valuemax={p.max} aria-label={partName(t, p.id)}>
              <i style={{ width: `${(100 * p.points) / p.max}%` }} />
            </span>
            <span className="bw-score__tip">{partDetail(p, t)}</span>
            {!compact && (
              <div className="score-evidence">
                <Collapse title={t('score.showBehind')}>
                  <p className="note-small">{t(`score.rule.${p.id}` as any)}</p>
                  <Evidence view={view} part={p} />
                </Collapse>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChainLine({ view, long = false }: { view: FarmView; long?: boolean }) {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const c = view.chain;
  const cp = s.snap?.chainSync[view.farm.id]?.checkpoint ?? null;
  return (
    <div className="chain-block">
      {!c ? (
        <span className="bw-badge bw-badge--none">{t('chain.checking')}</span>
      ) : c.ok ? (
        <span className="bw-badge bw-badge--ok"><CircleCheck className="bw-icon" aria-hidden="true" />{t('chain.intact', { n: c.count })}</span>
      ) : (
        <span className="bw-badge bw-badge--critical"><CircleDot className="bw-icon" aria-hidden="true" />{t('chain.broken', { n: c.brokenAtSeq ?? 0 })}</span>
      )}
      <p className="note-small">
        {cp ? t('chain.checkpoint', { when: f.dateTime(Date.parse(cp.receivedAt)) }) : t('chain.noCheckpoint')}
        {cp && !cp.chainOk ? ` · ${t('chain.serverSawBreak', { n: cp.brokenAtSeq ?? 0 })}` : ''}
      </p>
      {long && <p className="note-small">{t('chain.honest')}</p>}
    </div>
  );
}

const CHECK = [
  { id: 'provenance', s: 'have' }, { id: 'continuity', s: 'have' }, { id: 'tamper', s: 'partly' }, { id: 'verification', s: 'partly' },
  { id: 'calibration', s: 'not' }, { id: 'outcomes', s: 'not' }, { id: 'consent', s: 'not' }, { id: 'lender', s: 'not' },
] as const;
/** "What a lender would still need": honest gaps as Have / Partly / Not yet. */
export function Bankability() {
  const t = useT();
  return (
    <ul className="check-list">
      {CHECK.map((c) => (
        <li key={c.id} className={`check check--${c.s}`}>
          <span className={`check__status check__status--${c.s}`}>
            {c.s === 'have' ? <CircleCheck className="bw-icon" aria-hidden="true" /> : c.s === 'partly' ? <CircleDot className="bw-icon" aria-hidden="true" /> : <Circle className="bw-icon" aria-hidden="true" />}
            {t(`bank.status.${c.s}` as any)}
          </span>
          <div>
            <div className="check__title">{t(`bank.${c.id}` as any)}</div>
            <div className="note-small">{t(`bank.${c.id}.note` as any)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ Table that collapses to cards
export interface Col<R> {
  key: string;
  header: ReactNode;
  cell: (r: R) => ReactNode;
  num?: boolean;
  /** Used as the card title on phones instead of a label/value row. */
  title?: boolean;
  hideOnCard?: boolean;
}
export function DataTable<R>({ rows, cols, rowKey, onOpen, caption, rowLabel }: { rows: R[]; cols: Col<R>[]; rowKey: (r: R) => string; onOpen?: (r: R) => void; caption: string; rowLabel?: (r: R) => string }) {
  const titleCol = cols.find((c) => c.title) ?? cols[0]!;
  return (
    <>
      <div className="dt-table-wrap">
        <table className="sc-table dt">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>{cols.map((c) => <th key={c.key} scope="col" className={c.num ? 'sc-num' : ''}>{c.header}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className={onOpen ? 'dt-row--link' : ''} onClick={onOpen ? () => onOpen(r) : undefined}>
                {cols.map((c, i) => (
                  <td key={c.key} className={c.num ? 'sc-num' : ''}>
                    {i === 0 && onOpen ? <button type="button" className="dt-open" onClick={(e) => { e.stopPropagation(); onOpen(r); }} aria-label={rowLabel?.(r)}>{c.cell(r)}</button> : c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="dt-cards">
        {rows.map((r) => (
          <li key={rowKey(r)}>
            <button type="button" className="dt-card" onClick={onOpen ? () => onOpen(r) : undefined} disabled={!onOpen} aria-label={rowLabel?.(r)}>
              <div className="dt-card__title">{titleCol.cell(r)}</div>
              <dl className="dt-card__kv">
                {cols.filter((c) => c !== titleCol && !c.hideOnCard).map((c) => (
                  <div key={c.key} className="dt-card__pair">
                    <dt>{c.header}</dt>
                    <dd>{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="sc-stat bw-card stat-card">
      <div className="sc-stat__label">{label}</div>
      <div className="sc-stat__value">{value}</div>
      {sub && <div className="note-small">{sub}</div>}
    </div>
  );
}
export { thousands };
