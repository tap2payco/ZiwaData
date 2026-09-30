import { Camera, CircleCheck, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { DEMO_BUILD } from '../core/config';
import { dayKey } from '../core/format';
import { isPlausible } from '../core/rules';
import type { ReadingDraft } from '../core/types';
import { nowMs } from '../data/clock';
import { store, useApp, useViews } from '../data/store';
import { useT } from '../i18n';
import { href } from '../router';
import { DemoChip, StatusBadge, useFmt } from '../ui/bits';
import { Stepper } from '../ui/controls';
import { Card, OfflineBanner, PageHeader, SectionTitle, cageLabel, SyncBar } from '../ui/panels';

const verifPts = (v: { score: { parts: { id: string; points: number }[] } }) => v.score.parts.find((p) => p.id === 'verification')!.points;

export function ExtensionFarmsScreen() {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const views = useViews();
  const farms = Object.values(views).filter((v) => v.farm.assigned);
  return (
    <div className="screen">
      <PageHeader title={t('ext.title')} sub={<span>{t('ext.sub')} <DemoChip /></span>} />
      <OfflineBanner />
      <Card well>
        <h3 className="subhead"><ShieldCheck className="bw-icon" aria-hidden="true" /> {t('ext.whyTitle')}</h3>
        <p>{t('ext.why')}</p>
      </Card>
      <SectionTitle>{t('ext.assigned', { n: farms.length })}</SectionTitle>
      <ul className="cage-grid">
        {farms.map((v) => {
          const att = v.readings.filter((r) => r.attested);
          const last = att.length ? Date.parse(att[att.length - 1]!.ts) : null;
          return (
            <li key={v.farm.id}>
              <div className="bw-card cage-card">
                <div className="cage-card__head"><span className="subhead">{v.farm.ownerName}</span><StatusBadge status={v.worstStatus} /></div>
                <p className="note-small">{v.farm.name} {'·'} {t('ext.cages', { n: v.farm.cages.length })}</p>
                <dl className="kv">
                  <div><dt>{t('ext.lastAttest')}</dt><dd>{last ? f.date(last) : t('ext.never')}</dd></div>
                  <div><dt>{t('ext.attestedReadings')}</dt><dd>{att.length}</dd></div>
                  <div><dt>{t('score.part.verification')}</dt><dd>{verifPts(v)} / 20</dd></div>
                </dl>
                <a className="bw-btn bw-btn--secondary bw-btn--full" href={href('extension', 'attest', v.farm.id)}>{t('ext.attestVisit')}</a>
                <DemoChip />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AttestScreen({ initialFarm }: { initialFarm?: string }) {
  const t = useT();
  const s = useApp();
  const views = useViews();
  const assigned = Object.values(views).filter((v) => v.farm.assigned);
  const [farmId, setFarmId] = useState(initialFarm && views[initialFarm]?.farm.assigned ? initialFarm : assigned[0]?.farm.id ?? '');
  const farm = views[farmId]?.farm;
  const [cageId, setCageId] = useState('');
  const [doV, setDo] = useState('');
  const [tempV, setTemp] = useState('');
  const [cal, setCal] = useState('');
  const [photo, setPhoto] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ farmId: string; before: number } | null>(null);
  if (!farm) return null;
  const effCage = farm.cages.find((c) => c.id === cageId) ? cageId : farm.cages[0]!.id;
  const today = dayKey(s.now);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const nums: Record<string, number> = {};
    for (const [k, raw, min, max, kind] of [['do', doV, 0, 20, 'do'], ['temp', tempV, 10, 40, 'temp']] as const) {
      if (raw.trim() === '') continue;
      const n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n) || !isPlausible(kind, n)) errs[k] = t(`record.err.${k}` as any, { min, max });
      else nums[k] = n;
    }
    if (!Object.keys(nums).length && !Object.keys(errs).length) errs.form = t('ext.err.nothing');
    if (!cal) errs.cal = t('ext.err.calRequired');
    else if (cal > today) errs.cal = t('ext.err.calFuture');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const ts = new Date(nowMs()).toISOString();
    const base = { cageId: effCage, farmId, ts, source: 'manual' as const, via: 'attestation' as const, attested: true, demo: DEMO_BUILD, meterCalibratedOn: cal, attestedBy: 'Extension officer (demo)', photoName: photo || undefined, note: note.trim() || undefined };
    const drafts: ReadingDraft[] = [];
    if (nums.do !== undefined) drafts.push({ ...base, kind: 'do', value: nums.do, unit: 'mg/L' });
    if (nums.temp !== undefined) drafts.push({ ...base, kind: 'temp', value: nums.temp, unit: '°C' });
    const before = verifPts(views[farmId]!);
    await store.record(farmId, drafts);
    setDone({ farmId, before });
  };
  if (done) {
    const now = views[done.farmId] ? verifPts(views[done.farmId]!) : done.before;
    return (
      <div className="screen">
        <PageHeader title={t('ext.savedTitle')} />
        <OfflineBanner />
        <Card>
          <p className="saved-line"><CircleCheck className="bw-icon" aria-hidden="true" /> <strong>{t('record.savedPhone')}</strong> {!s.online ? t('record.willSend') : ''}</p>
          <p>{t('ext.verifChange', { farm: views[done.farmId]!.farm.ownerName, a: done.before, b: now })}</p>
          <p className="note-small">{t('ext.why')}</p>
          <div className="btn-row">
            <button type="button" className="bw-btn bw-btn--lg" onClick={() => { setDone(null); setDo(''); setTemp(''); setNote(''); setPhoto(''); }}>{t('ext.another')}</button>
            <a className="bw-btn bw-btn--lg bw-btn--secondary" href={href('extension', 'farms')}>{t('nav.farms')}</a>
          </div>
        </Card>
      </div>
    );
  }
  const errList = Object.values(errors);
  return (
    <div className="screen">
      <PageHeader title={t('ext.attestTitle')} sub={<span>{t('ext.attestSub')} <DemoChip /></span>} />
      <OfflineBanner />
      <Card well><p>{t('ext.why')}</p></Card>
      <form onSubmit={submit} noValidate className="record-form">
        {errList.length > 0 && <div className="error-summary" role="alert"><strong>{t('record.fixThese')}</strong><ul>{errList.map((m, i) => <li key={i}>{m}</li>)}</ul></div>}
        <Card>
          <label className="bw-field-label" htmlFor="afarm">{t('ext.farm')}</label>
          <select id="afarm" className="select" value={farmId} onChange={(e) => { setFarmId(e.target.value); setCageId(''); }}>
            {assigned.map((v) => <option key={v.farm.id} value={v.farm.id}>{v.farm.ownerName} {'—'} {v.farm.name}</option>)}
          </select>
          <label className="bw-field-label" htmlFor="acage">{t('record.cage')}</label>
          <select id="acage" className="select" value={effCage} onChange={(e) => setCageId(e.target.value)}>
            {farm.cages.map((c) => <option key={c.id} value={c.id}>{cageLabel(t, c)}</option>)}
          </select>
        </Card>
        <p className="note-small">{t('ext.meterNote')}</p>
        <div className="record-grid">
          <Card><Stepper label={t('ext.doMeter')} unit="mg/L" value={doV} onChange={setDo} step={0.1} min={0} max={20} start={6} decimals={1} error={errors.do} hint={t('record.range', { min: 0, max: 20 })} /></Card>
          <Card><Stepper label={t('ext.tempMeter')} unit={'°C'} value={tempV} onChange={setTemp} step={0.1} min={10} max={40} start={27} decimals={1} error={errors.temp} hint={t('record.range', { min: 10, max: 40 })} /></Card>
        </div>
        <Card>
          <label className="bw-field-label" htmlFor="cal">{t('ext.calDate')} <span className="req">({t('hold.required')})</span></label>
          <input id="cal" type="date" className="select" value={cal} max={today} onChange={(e) => setCal(e.target.value)} aria-invalid={!!errors.cal} />
          {errors.cal && <div className="field-error" role="alert">{errors.cal}</div>}
          <label className="bw-field-label" htmlFor="photo"><Camera className="bw-icon" aria-hidden="true" /> {t('ext.photo')}</label>
          <input id="photo" type="file" accept="image/*" className="file" onChange={(e) => setPhoto(e.target.files?.[0]?.name ?? '')} />
          <p className="note-small">{t('ext.photoStub')}</p>
          <label className="bw-field-label" htmlFor="anote">{t('record.note')}</label>
          <textarea id="anote" className="textarea" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Card>
        <button type="submit" className="bw-btn bw-btn--lg bw-btn--full">{t('ext.save')}</button>
        <SyncBar />
      </form>
    </div>
  );
}
