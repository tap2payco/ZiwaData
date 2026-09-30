import { ArrowLeft, Check, Lock, Printer, Circle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatMoney } from '../core/format';
import type { Reading } from '../core/types';
import type { FarmView } from '../data/derived';
import { store, useApp, useViews } from '../data/store';
import { useT, type T } from '../i18n';
import { href, navigate } from '../router';
import { DemoChip, StatusBadge, StatusIcon, useFmt } from '../ui/bits';
import { Bankability, Card, ChainLine, DataTable, PageHeader, ReadingRow, ScorePanel, SectionTitle, Stat, cageLabel, type Col } from '../ui/panels';
import { OfflineBanner } from '../ui/panels';
import { Collapse } from '../ui/controls';
import { CircleDot, CircleCheck } from 'lucide-react';

const verifiedShare = (v: FarmView) => {
  const p = v.score.parts.find((x) => x.id === 'verification')!;
  return p.facts.total ? Math.round((100 * p.facts.verified!) / p.facts.total!) : null;
};
const TRANCHES = [300_000, 300_000, 400_000];

/** Effective tranche-2 state: a lender's manual Hold/Release overrides the rule, and the reason is kept. */
export function trancheState(v: FarmView, actions: { farmId: string; action: 'hold' | 'release'; reason: string; ts: string }[]) {
  const mine = actions.filter((a) => a.farmId === v.farm.id).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const last = mine[0];
  if (last) return { kind: last.action === 'hold' ? 'manual_hold' : 'manual_release', reason: last.reason, by: last } as const;
  // Extra to the spec rule: a record chain that fails verification also holds the tranche (a lender cannot rely on an edited record).
  const reasons: string[] = [...v.score.holdReasons];
  if (v.chain && !v.chain.ok) reasons.push('chain_broken');
  return { kind: reasons.length ? 'rule_hold' : 'ready', reasons } as const;
}

export function LenderPortfolioScreen() {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const views = useViews();
  const actions = s.snap?.lenderActions ?? [];
  const rows = useMemo(() => Object.values(views).sort((a, b) => b.score.total - a.score.total), [views]);
  if (!rows.length) return null;
  const avg = Math.round(rows.reduce((x, v) => x + v.score.total, 0) / rows.length);
  const holds = rows.filter((v) => { const st = trancheState(v, actions); return st.kind === 'rule_hold' || st.kind === 'manual_hold'; }).length;
  const breaks = rows.filter((v) => v.chain && !v.chain.ok).length;
  const cols: Col<FarmView>[] = [
    { key: 'rank', header: '#', cell: (v) => rows.indexOf(v) + 1, num: true, hideOnCard: true },
    { key: 'who', header: t('lender.col.borrower'), title: true, cell: (v) => <span className="who"><strong>{v.farm.ownerName}</strong><span className="note-small">{v.farm.name}</span></span> },
    { key: 'score', header: t('lender.col.score'), num: true, cell: (v) => <strong>{v.score.total}</strong> },
    { key: 'status', header: t('lender.col.status'), cell: (v) => <StatusBadge status={v.worstStatus} /> },
    { key: 'days', header: t('lender.col.days'), num: true, cell: (v) => (v.score.daysSinceLast === null ? '—' : Math.floor(v.score.daysSinceLast) === 0 ? t('lender.today') : t('lender.days', { n: Math.floor(v.score.daysSinceLast) })) },
    { key: 'ver', header: t('lender.col.verified'), num: true, cell: (v) => { const p = verifiedShare(v); return p === null ? '—' : `${p}%`; } },
    { key: 'alerts', header: t('lender.col.alerts'), num: true, cell: (v) => v.active.length },
    { key: 'chain', header: t('lender.col.chain'), cell: (v) => (!v.chain ? <span className="note-small">{t('chain.checking')}</span> : v.chain.ok ? <span className="bw-badge bw-badge--ok"><CircleCheck className="bw-icon" aria-hidden="true" />{t('lender.chainOk')}</span> : <span className="bw-badge bw-badge--critical"><CircleDot className="bw-icon" aria-hidden="true" />{t('lender.chainBroken', { n: v.chain.brokenAtSeq ?? 0 })}</span>) },
    { key: 'tr', header: t('lender.col.tranche'), cell: (v) => { const st = trancheState(v, actions); return st.kind === 'rule_hold' || st.kind === 'manual_hold' ? <StatusBadge status="watch" /> : <StatusBadge status="ok" />; } },
  ];
  // Tranche column shows the word too, via aria + visible text
  cols[cols.length - 1]!.cell = (v) => { const st = trancheState(v, actions); const hold = st.kind === 'rule_hold' || st.kind === 'manual_hold'; return <span className={`bw-badge bw-badge--${hold ? 'watch' : 'ok'}`}><StatusIcon status={hold ? 'watch' : 'ok'} />{hold ? t('tranche.onHold') : t('tranche.ready')}</span>; };
  return (
    <div className="screen screen--wide">
      <PageHeader title={t('lender.title')} sub={<span>{t('lender.sub', { n: rows.length })} <DemoChip /></span>} right={<span className="bw-src bw-src--demo">{t('tranche.simulatedShort')}</span>} />
      <OfflineBanner />
      <div className="stat-grid">
        <Stat label={t('lender.stat.borrowers')} value={rows.length} sub={t('demo.chip')} />
        <Stat label={t('lender.stat.avg')} value={avg} sub={t('lender.stat.avgNote')} />
        <Stat label={t('lender.stat.holds')} value={holds} sub={t('tranche.simulatedShort')} />
        <Stat label={t('lender.stat.breaks')} value={breaks} sub={t('lender.stat.breaksNote')} />
      </div>
      <DataTable rows={rows} cols={cols} rowKey={(v) => v.farm.id} caption={t('lender.title')} onOpen={(v) => navigate('lender', 'b', v.farm.id)} rowLabel={(v) => t('lender.open', { n: v.farm.ownerName })} />
      <p className="note-small">{t('lender.rankNote')}</p>
    </div>
  );
}

function TrancheTimeline({ v }: { v: FarmView }) {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const st = trancheState(v, s.snap?.lenderActions ?? []);
  let t2: { cls: string; state: string; cond: string };
  if (st.kind === 'manual_hold') t2 = { cls: 'locked', state: t('tranche.state.manualHold'), cond: t('tranche.cond.manual', { reason: st.reason }) };
  else if (st.kind === 'manual_release') t2 = { cls: 'done', state: t('tranche.state.manualRelease'), cond: t('tranche.cond.manual', { reason: st.reason }) };
  else if (st.kind === 'rule_hold') t2 = { cls: 'locked', state: t('tranche.state.hold'), cond: st.reasons.map((r) => t(`hold.${r}` as any, { d: v.score.daysSinceLast ? Math.floor(v.score.daysSinceLast) : 0 })).join(' ') };
  else t2 = { cls: 'next', state: t('tranche.state.ready'), cond: t('tranche.cond.ready') };
  const Node = ({ cls }: { cls: string }) => <span className="bw-tl__node">{cls === 'done' ? <Check className="bw-icon" aria-hidden="true" /> : cls === 'locked' ? <Lock className="bw-icon" aria-hidden="true" /> : <Circle className="bw-icon" aria-hidden="true" />}</span>;
  return (
    <div>
      <p className="note-small"><strong>{t('tranche.simulatedShort')}</strong> {t('tranche.simulated')}</p>
      <ol className="bw-tl">
        <li className="bw-tl__item bw-tl__item--done"><Node cls="done" /><div><div className="bw-tl__head"><span className="bw-tl__title">{t('tranche.n', { n: 1 })}</span><span className="bw-tl__amt">{formatMoney(TRANCHES[0]!)}</span></div><span className="bw-tl__state">{t('tranche.state.released')}</span></div></li>
        <li className={`bw-tl__item bw-tl__item--${t2.cls}`}><Node cls={t2.cls} /><div><div className="bw-tl__head"><span className="bw-tl__title">{t('tranche.n', { n: 2 })}</span><span className="bw-tl__amt">{formatMoney(TRANCHES[1]!)}</span></div><span className="bw-tl__state">{t2.state}</span><p className="bw-tl__cond">{t2.cond}</p></div></li>
        <li className="bw-tl__item bw-tl__item--locked"><Node cls="locked" /><div><div className="bw-tl__head"><span className="bw-tl__title">{t('tranche.n', { n: 3 })}</span><span className="bw-tl__amt">{formatMoney(TRANCHES[2]!)}</span></div><span className="bw-tl__state">{t('tranche.state.locked')}</span><p className="bw-tl__cond">{t('tranche.cond.after')}</p></div></li>
      </ol>
      <p className="note-small">{t('tranche.rule')}</p>
    </div>
  );
}

function HoldRelease({ v }: { v: FarmView }) {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const [action, setAction] = useState<'hold' | 'release'>('hold');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const mine = (s.snap?.lenderActions ?? []).filter((a) => a.farmId === v.farm.id).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = reason.trim();
    if (r.length < 8 || r.split(/\s+/).length < 2) return setErr(t('hold.err.reason'));
    setErr(null);
    await store.addLenderAction(v.farm.id, action, r);
    setReason('');
  };
  return (
    <form onSubmit={submit} noValidate>
      <div className="chip-group" role="radiogroup" aria-label={t('hold.action')}>
        <button type="button" role="radio" aria-checked={action === 'hold'} className="chip-opt" onClick={() => setAction('hold')}>{t('hold.hold')}</button>
        <button type="button" role="radio" aria-checked={action === 'release'} className="chip-opt" onClick={() => setAction('release')}>{t('hold.release')}</button>
      </div>
      <label className="bw-field-label" htmlFor="reason">{t('hold.reason')} <span className="req">({t('hold.required')})</span></label>
      <textarea id="reason" className="textarea" rows={3} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!err} aria-describedby={err ? 'reason-err' : undefined} />
      {err && <div id="reason-err" className="field-error" role="alert">{err}</div>}
      <button type="submit" className="bw-btn bw-btn--lg bw-btn--full">{action === 'hold' ? t('hold.confirmHold') : t('hold.confirmRelease')}</button>
      <p className="note-small">{t('hold.note')}</p>
      {mine.length > 0 && (
        <ul className="plain-list history">
          {mine.map((a) => <li key={a.ts}><strong>{a.action === 'hold' ? t('hold.hold') : t('hold.release')}</strong> {'·'} {f.dateTime(Date.parse(a.ts))}<br />{a.reason}</li>)}
        </ul>
      )}
    </form>
  );
}

export function LenderDetailScreen({ farmId }: { farmId: string }) {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const views = useViews();
  const v = views[farmId];
  const [shown, setShown] = useState(15);
  if (!v) return <div className="screen"><PageHeader title={t('lender.title')} /></div>;
  const recent = [...v.readings].reverse();
  const cages = new Map(v.farm.cages.map((c) => [c.id, c]));
  const cp = s.snap?.chainSync[v.farm.id]?.checkpoint ?? null;
  return (
    <div className="screen screen--wide">
      <PageHeader
        back={<a className="back-link" href={href('lender', 'portfolio')}><ArrowLeft className="bw-icon" aria-hidden="true" /> {t('lender.title')}</a>}
        title={v.farm.ownerName}
        sub={<span>{v.farm.name} <DemoChip /> <span className="bw-src bw-src--demo">{t('tranche.simulatedShort')}</span></span>}
        right={<a className="bw-btn bw-btn--secondary" href={href('lender', 'pack', v.farm.id)}><Printer className="bw-icon" aria-hidden="true" /> {t('pack.export')}</a>}
      />
      <OfflineBanner />
      <div className="detail-grid detail-grid--lender">
        <div className="stack">
          <Card><ScorePanel view={v} /></Card>
          <Card>
            <h3 className="subhead">{t('tranche.title')}</h3>
            <TrancheTimeline v={v} />
          </Card>
          <Card>
            <h3 className="subhead">{t('hold.title')}</h3>
            <HoldRelease v={v} />
          </Card>
        </div>
        <div className="stack">
          <Card>
            <h3 className="subhead">{t('chain.title')}</h3>
            <ChainLine view={v} long />
            <p className="note-small">{cp ? t('lender.lastCheckpoint', { when: f.dateTime(Date.parse(cp.receivedAt)) }) : t('chain.noCheckpoint')} {t('chain.firstStep')}</p>
          </Card>
          <Card>
            <h3 className="subhead">{t('bank.title')}</h3>
            <p className="note-small">{t('bank.intro')}</p>
            <Bankability />
          </Card>
          <Card>
            <h3 className="subhead">{t('lender.cages')}</h3>
            <ul className="plain-list cage-status">
              {v.cages.map((c) => <li key={c.cage.id}><span>{cageLabel(t, c.cage)}</span><StatusBadge status={c.status} /></li>)}
            </ul>
          </Card>
        </div>
      </div>
      <Card>
        <SectionTitle right={<DemoChip />}>{t('lender.timeline')}</SectionTitle>
        <p className="note-small">{t('lender.timelineNote')}</p>
        <ul className="reading-list reading-list--cols">{recent.slice(0, shown).map((r: Reading) => <ReadingRow key={r.id} r={r} cage={cages.get(r.cageId)} now={s.now} />)}</ul>
        {shown < recent.length && <button type="button" className="bw-btn bw-btn--secondary" onClick={() => setShown(shown + 30)}>{t('lender.showMore', { n: Math.min(30, recent.length - shown) })}</button>}
      </Card>
    </div>
  );
}
export { Collapse };
