import { ArrowLeft, Printer } from 'lucide-react';
import { RULES } from '../core/config';
import { num } from '../core/format';
import type { Reading } from '../core/types';
import type { Role } from '../data/prefs';
import { useApp, useViews } from '../data/store';
import { useT } from '../i18n';
import { href } from '../router';
import { Wordmark } from '../App';
import { DemoChip, SourceTag, StatusBadge, useFmt } from '../ui/bits';
import { Bankability, ChainLine, PageHeader, ReadingRow, alertText, cageLabel, partName } from '../ui/panels';
import { ScoreRing } from '../ui/charts';

/** Printable lender pack. window.print() uses the print stylesheet in app.css (navigation and buttons are hidden). */
export function PackScreen({ farmId, role }: { farmId: string; role: Role }) {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const v = useViews()[farmId];
  if (!v) return null;
  const sc = v.score;
  const back = role === 'lender' ? href('lender', 'b', farmId) : href('farmer', 'score');
  const water = v.readings.filter((r) => ['do', 'temp', 'ph', 'temp_deep'].includes(r.kind) && Date.parse(r.ts) > s.now - 30 * 86400_000);
  const share = (src: Reading['source']) => (water.length ? Math.round((100 * water.filter((r) => r.source === src).length) / water.length) : 0);
  const attested = v.readings.filter((r) => r.attested);
  const incidents = v.readings.filter((r) => r.kind === 'incident' && Date.parse(r.ts) > s.now - 30 * 86400_000);
  const alerts = v.alerts.filter((a) => Date.parse(a.firstFiredAt) > s.now - 30 * 86400_000);
  const cp = s.snap?.chainSync[farmId]?.checkpoint ?? null;
  return (
    <div className="screen pack">
      <div className="no-print">
        <a className="back-link" href={back}><ArrowLeft className="bw-icon" aria-hidden="true" /> {t('pack.back')}</a>
        <button type="button" className="bw-btn bw-btn--lg" onClick={() => window.print()}><Printer className="bw-icon" aria-hidden="true" /> {t('pack.print')}</button>
      </div>
      <div className="bw-evi pack-doc">
        <div className="pack-head">
          <Wordmark />
          <div>
            <h1 className="bw-evi__title">{t('pack.title')}</h1>
            <p className="bw-evi__sub">{v.farm.ownerName} {'·'} {v.farm.name} {'·'} {t('pack.generated', { when: f.dateTime(s.now) })}</p>
            <p className="bw-evi__sub"><DemoChip /> {t('tranche.simulatedShort')}</p>
          </div>
        </div>
        <p className="pack-disclaimer">{t('pack.disclaimer')}</p>

        <section className="pack-sec">
          <h2 className="bw-evi__h">{t('score.title')}</h2>
          <div className="pack-score">
            <ScoreRing score={sc.total} size={132} label={t('score.ringLabel', { n: sc.total })} />
            <table className="pack-table">
              <tbody>
                {sc.parts.map((p) => <tr key={p.id}><th scope="row">{partName(t, p.id)}</th><td className="sc-num">{p.points} / {p.max}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="note-small">{t('score.rulesNotAi')} {t('tranche.rule')}</p>
        </section>

        <section className="pack-sec">
          <h2 className="bw-evi__h">{t('chain.title')}</h2>
          <ChainLine view={v} long />
          {cp && <p className="note-small">{t('pack.headHash', { h: cp.headHash.slice(0, 16), n: cp.headSeq })}</p>}
        </section>

        <section className="pack-sec">
          <h2 className="bw-evi__h">{t('pack.sources')}</h2>
          <div className="bw-evi__mix" role="img" aria-label={t('pack.sourcesAria', { s: share('sensor'), m: share('manual'), t: share('satellite') })}>
            <i className="s" style={{ width: `${share('sensor')}%` }} /><i className="m" style={{ width: `${share('manual')}%` }} /><i className="t" style={{ width: `${share('satellite')}%` }} />
          </div>
          <div className="bw-evi__mixkey">
            <span className="bw-evi__mixitem"><SourceTag source="sensor" /> <b>{share('sensor')}%</b></span>
            <span className="bw-evi__mixitem"><SourceTag source="manual" /> <b>{share('manual')}%</b></span>
            <span className="bw-evi__mixitem"><SourceTag source="satellite" /> <b>{share('satellite')}%</b></span>
          </div>
          <p className="note-small">{t('pack.attested', { n: attested.length })}</p>
        </section>

        <section className="pack-sec">
          <h2 className="bw-evi__h">{t('pack.cages')}</h2>
          <table className="pack-table pack-table--cages">
            <thead><tr><th scope="col">{t('record.cage')}</th><th scope="col">{t('lender.col.status')}</th><th scope="col" className="sc-num">{t('pack.readings30')}</th><th scope="col" className="sc-num">{t('kind.do.short')} {t('pack.now')}</th><th scope="col" className="sc-num">{t('pack.doMin')}</th></tr></thead>
            <tbody>
              {v.cages.map((c) => {
                const dos = c.readings.filter((r) => r.kind === 'do' && Date.parse(r.ts) > s.now - 30 * 86400_000).map((r) => r.value as number);
                return (
                  <tr key={c.cage.id}>
                    <th scope="row">{cageLabel(t, c.cage)}</th>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="sc-num">{c.readings.filter((r) => Date.parse(r.ts) > s.now - 30 * 86400_000 && r.kind !== 'incident').length}</td>
                    <td className="sc-num">{c.do ? num(c.do.value as number) : '—'}</td>
                    <td className="sc-num">{dos.length ? num(Math.min(...dos)) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="pack-sec">
          <h2 className="bw-evi__h">{t('pack.incidents')}</h2>
          {incidents.length === 0 ? <p className="note-small">{t('incidents.none')}</p> : <ul className="reading-list">{incidents.map((r) => <ReadingRow key={r.id} r={r} cage={v.farm.cages.find((c) => c.id === r.cageId)} now={s.now} />)}</ul>}
          <p className="note-small">{t('incidents.note')}</p>
        </section>

        <section className="pack-sec">
          <h2 className="bw-evi__h">{t('pack.alerts', { n: alerts.length })}</h2>
          <ul className="plain-list">
            {alerts.map((a) => { const x = alertText(a, t, v.farm.cages.find((c) => c.id === a.cageId)); return <li key={a.id}><strong>{x.title}</strong> {'·'} {f.dateTime(Date.parse(a.firstFiredAt))}{a.clearedAt ? ` → ${f.dateTime(Date.parse(a.clearedAt))}` : ` → ${t('pack.stillActive')}`}<br /><span className="note-small">{x.rule}</span></li>; })}
          </ul>
          <p className="note-small">{t('demo.defaultNote')} {t('rules.doDefaults', { ok: RULES.do.okMin.toFixed(1), crit: RULES.do.criticalBelow.toFixed(1) })}</p>
        </section>

        <section className="pack-sec">
          <h2 className="bw-evi__h">{t('bank.title')}</h2>
          <Bankability />
        </section>
        <div className="bw-evi__foot">{t('pack.foot')}</div>
      </div>
    </div>
  );
}
export { PageHeader };
