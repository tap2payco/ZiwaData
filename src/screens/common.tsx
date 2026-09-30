import { CircleCheck, RefreshCw, Send, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../brand';
import { RULES, DEMO_POINT } from '../core/config';
import { normalizeTzPhone } from '../core/phone';
import { ALL_TEMPLATE_IDS, renderSms, smsLength, isGsm7, SMS_MAX, type SmsTemplateId } from '../core/sms-templates';
import { http, type BoxStatus, type DevicesResponse, type InboundResult, type SmsHealth, type SmsLogEntry, type SmsStatus, type WeatherResponse } from '../data/api';
import { store, useApp } from '../data/store';
import { DEFAULT_SETTINGS } from '../data/engine';
import { useLang, useT, type Key } from '../i18n';
import { href } from '../router';
import { DemoChip, useFmt } from '../ui/bits';
import { Segmented, Sheet, Switch } from '../ui/controls';
import { Card, OfflineBanner, PageHeader, SectionTitle, DataTable, type Col } from '../ui/panels';
import { nowMs } from '../data/clock';

// ------------------------------------------------------------------ Data sources
const ROUTE_IDS = ['water', 'land', 'devices', 'device_path', 'eo_locations', 'eo_stac', 'api_keys', 'auth_me'] as const;

export function SourcesScreen() {
  const t = useT();
  const s = useApp();
  const f = useFmt(s.now);
  const [box, setBox] = useState<BoxStatus | null>(null);
  const [devices, setDevices] = useState<DevicesResponse | null>(null);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [sms, setSms] = useState<SmsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Beem health is only ever fetched when the button is pressed: loading a page must never call Beem.
  const [health, setHealth] = useState<SmsHealth | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const checkHealth = async () => {
    setHealthBusy(true);
    try { setHealth(await http.get<SmsHealth>('/api/sms/health')); } catch { setHealth(null); } finally { setHealthBusy(false); }
  };

  const load = useCallback(async (test: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const [b, d, w, m] = await Promise.all([
        test ? http.post<BoxStatus>('/api/box/test') : http.get<BoxStatus>('/api/box/status'),
        http.get<DevicesResponse>('/api/box/devices'),
        http.get<WeatherResponse>(`/api/box/weather?lat=${DEMO_POINT.lat}&lon=${DEMO_POINT.lon}`),
        http.get<SmsStatus>('/api/sms/status'),
      ]);
      setBox(b); setDevices(d); setWeather(w); setSms(m);
    } catch (e) {
      setErr(t(s.online ? 'sources.err.server' : 'sources.err.offline'));
    } finally {
      setBusy(false);
    }
  }, [s.online, t]);
  useEffect(() => { void load(false); }, [load]);

  const rows = ROUTE_IDS.map((id) => box?.routes.find((r) => r.id === id) ?? null).filter((r): r is NonNullable<typeof r> => !!r);
  const cols: Col<(typeof rows)[number]>[] = [
    { key: 'ep', header: t('sources.col.endpoint'), title: true, cell: (r) => <span className="who"><code>{r.method} {r.path}</code><span className="note-small">{t('sources.auth', { a: r.auth.join(', ') })}</span></span> },
    { key: 'used', header: t('sources.col.used'), cell: (r) => (r.used ? t(`src.route.${r.id}.used` as Key) : t('sources.notUsed')) },
    { key: 'mode', header: t('sources.col.mode'), cell: (r) => <ModeChip mode={r.mode} /> },
    { key: 'test', header: t('sources.col.test'), cell: (r) => (!r.configured ? <span className="note-small">{t('sources.noCred')}</span> : !r.lastTest ? <span className="note-small">{t('sources.notTested')}</span> : r.lastTest.ok ? <span className="note-small">{t('sources.testOk', { when: f.dateTime(Date.parse(r.lastTest.at)) })}</span> : <span className="note-small">{t('sources.testFail', { e: r.lastTest.error ?? '' })}</span>) },
    { key: 'conf', header: t('sources.col.confirmed'), cell: (r) => t(`src.route.${r.id}.confirmed` as Key) },
    { key: 'gap', header: t('sources.col.gap'), cell: (r) => t(`src.route.${r.id}.gap` as Key) },
  ];
  return (
    <div className="screen screen--wide">
      <PageHeader title={t('sources.title')} sub={<span>{t('sources.sub')} <DemoChip /></span>}
        right={<button type="button" className="bw-btn bw-btn--secondary" disabled={busy || !s.online} onClick={() => void load(true)}><RefreshCw className="bw-icon" aria-hidden="true" /> {t('sources.test')}</button>} />
      <OfflineBanner />
      {err && <div className="error-summary" role="alert">{err}</div>}
      <Card well>
        <h3 className="subhead">{t('sources.honestTitle')}</h3>
        <ul className="plain-list">
          <li>{t('sources.honest1')}</li>
          <li>{t('sources.honest2')}</li>
          <li>{t('sources.honest3')}</li>
        </ul>
      </Card>
      {box && (
        <>
          <SectionTitle>{t('sources.boxTitle')}</SectionTitle>
          <p className="note-small">{t('sources.boxIntro', { url: box.baseUrl })} {t('sources.creds', { k: box.keyConfigured ? t('common.yes') : t('common.no'), b: box.bearerConfigured ? t('common.yes') : t('common.no') })}</p>
          <DataTable rows={rows} cols={cols} rowKey={(r) => r.id} caption={t('sources.boxTitle')} />
        </>
      )}
      {weather && (
        <Card>
          <h3 className="subhead">{t('sources.weatherTitle')} <ModeChip mode={weather.mode} /></h3>
          <p>{t('sources.weatherNow', { w: weather.forecast.windKmh === null ? '—' : Math.round(weather.forecast.windKmh), r: weather.forecast.rainMm === null ? '—' : Math.round(weather.forecast.rainMm) })} {weather.mode === 'demo' && <DemoChip />}</p>
          <p className="note-small">{t('weather.note')}</p>
          {weather.liveError && <p className="note-small">{t('sources.liveFailed', { e: weather.liveError })}</p>}
          {weather.mode === 'live' && weather.raw && <p className="note-small">{t('sources.unverifiedMap', { w: String(weather.raw.wind ?? '—'), wu: weather.raw.windUnit ?? t('sources.unitUnknown') })}</p>}
        </Card>
      )}
      {devices && (
        <Card>
          <h3 className="subhead">{t('sources.devicesTitle')} <ModeChip mode={devices.mode} /></h3>
          <p className="note-small">{t('sources.devicesNote')}</p>
          <ul className="plain-list">
            {devices.mapped.devices.map((d) => {
              const rs = devices.mapped.readings.filter((r) => r.deviceId === d.id);
              const wx = devices.mapped.weather.find((w) => w.deviceId === d.id);
              return (
                <li key={d.id}>
                  <strong>{d.name}</strong> <span className="note-small">({d.type}, {d.id})</span>
                  <div className="note-small">
                    {rs.map((r) => `${t(`kind.${r.kind}` as Key)} ${typeof r.value === 'number' ? r.value.toFixed(1) : r.value} ${r.unit === 'pH' ? '' : r.unit}`).join(' · ')}
                    {wx ? `${t('sources.wind')} ${wx.windKmh ?? '—'} km/h · ${t('sources.rain')} ${wx.rainMm ?? '—'} mm` : ''}
                    {devices.mode === 'demo' ? ' ' : ''}{devices.mode === 'demo' && <DemoChip />}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {sms && (
        <Card>
          <h3 className="subhead">{t('sources.smsTitle')} <ModeChip mode={(health?.live ?? sms.live) ? 'live' : 'demo'} label={sms.mode === 'dry-run' ? t('sms.dryRunMode') : undefined} /></h3>
          <dl className="kv">
            <div><dt>{t('sources.sms.mode')}</dt><dd>{sms.mode === 'dry-run' ? t('sms.dryRunMode') : t('sms.configuredMode')}</dd></div>
            <div><dt>{t('sources.sms.sender')}</dt><dd>{sms.senderIdSet ? t('common.yes') : t('common.no')}{health?.senderIdIssue && health.senderIdIssue !== 'missing' ? ` (${t(`sms.health.sender.${health.senderIdIssue}` as Key)})` : ''}</dd></div>
            <div><dt>{t('sources.sms.live')}</dt><dd>{(health?.live ?? sms.live) ? t('common.yes') : t('common.no')}</dd></div>
            <div><dt>{t('sources.sms.limit')}</dt><dd>{sms.maxPerHour}</dd></div>
            {/* Only shown once the health check has actually run: a blank here is "not checked", not "unreachable". */}
            {health && <div><dt>{t('sms.health.reachable')}</dt><dd>{health.reachable === null ? t('sms.health.notChecked') : health.reachable ? t('common.yes') : t('common.no')}</dd></div>}
            {health && <div><dt>{t('sms.health.balance')}</dt><dd>{health.balance === null ? t('sms.health.unknown') : String(health.balance)}</dd></div>}
          </dl>
          <p className="note-small">{sms.mode === 'dry-run' ? t('sms.dryRunExplain') : t('sms.liveNote')}</p>
          <button type="button" className="bw-btn bw-btn--secondary bw-btn--sm" disabled={healthBusy} onClick={() => void checkHealth()}>
            {t('sms.health.check')}
          </button>
          {health && <p className="note-small" role="status">{t('sms.health.checkedAt', { when: f.dateTime(Date.parse(health.checkedAt)) })}{health.error ? ` · ${health.error}` : ''}</p>}
          <p className="note-small">{t('sms.health.note')}</p>
        </Card>
      )}
      <Card>
        <h3 className="subhead">{t('sources.otherTitle')}</h3>
        <ul className="plain-list">
          <li><strong>{t('sources.inbound')}</strong> {t('sources.inboundNote')}</li>
          <li><strong>{t('sources.ussd')}</strong> {t('sources.ussdNote')}</li>
          <li><strong>{t('sources.sync')}</strong> {t('sources.syncNote')}</li>
        </ul>
      </Card>
    </div>
  );
}
function ModeChip({ mode, label }: { mode: 'demo' | 'live'; label?: string }) {
  const t = useT();
  return mode === 'live' ? <span className="bw-badge bw-badge--ok">{t('sources.mode.live')}</span> : <span className="bw-src bw-src--demo">{label ?? t('sources.mode.demo')}</span>;
}

// ------------------------------------------------------------------ Settings
export function SettingsScreen() {
  const t = useT();
  const s = useApp();
  const snap = s.snap!;
  const [phone, setPhone] = useState('');
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneOk, setPhoneOk] = useState<string | null>(null);
  const [inbound, setInbound] = useState('RIPOTI K3 OKS 5.2 JOTO 27.5 PH 7.4');
  const [inboundRes, setInboundRes] = useState<InboundResult | null>(null);
  const [inboundErr, setInboundErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const settings = snap.settings;
  const setSettings = (next: typeof settings) => void store.saveSettings(next);

  const savePhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhoneOk(null);
    if (!normalizeTzPhone(phone)) return setPhoneErr(t('settings.phone.err'));
    setPhoneErr(null);
    try {
      await http.put('/api/settings', { phone });
      setPhone('');
      setPhoneOk(t('settings.phone.saved'));
      await store.sync();
    } catch {
      setPhoneErr(t(s.online ? 'sources.err.server' : 'settings.phone.needSignal'));
    }
  };
  const removePhone = async () => {
    try { await http.put('/api/settings', { phone: null }); setPhoneOk(t('settings.phone.removed')); await store.sync(); } catch { setPhoneErr(t('settings.phone.needSignal')); }
  };
  const simulate = async (e: React.FormEvent) => {
    e.preventDefault();
    setInboundErr(null); setInboundRes(null);
    try {
      const r = await http.post<InboundResult>('/api/sms/inbound', { text: inbound });
      setInboundRes(r);
      if (r.ok) await store.sync();
    } catch { setInboundErr(t(s.online ? 'sources.err.server' : 'settings.phone.needSignal')); }
  };
  const toggles: { k: keyof typeof settings.smsAlertTypes; label: Key }[] = [
    { k: 'do', label: 'settings.type.do' }, { k: 'temp', label: 'settings.type.temp' }, { k: 'ph', label: 'settings.type.ph' },
    { k: 'turnover', label: 'settings.type.turnover' }, { k: 'weather', label: 'settings.type.weather' }, { k: 'stale', label: 'settings.type.stale' },
  ];
  const errKey = inboundRes && !inboundRes.ok ? (`sms.parse.${inboundRes.error}` as Key) : null;
  return (
    <div className="screen">
      <PageHeader title={t('settings.title')} sub={<span>{BRAND.name} {'·'} <DemoChip /></span>} />
      <OfflineBanner />
      <div className="detail-grid">
        <div className="stack">
          <Card>
            <h3 className="subhead">{t('settings.language')}</h3>
            <Segmented label={t('settings.language')} value={s.lang} onChange={(v) => store.setLang(v)} options={[{ value: 'sw', label: 'Kiswahili' }, { value: 'en', label: 'English' }]} />
            <p className="note-small review-note"><TriangleAlert className="bw-icon" aria-hidden="true" /> {t('settings.swReview')}</p>
            <h3 className="subhead">{t('settings.theme')}</h3>
            <Segmented label={t('settings.theme')} value={s.theme} onChange={(v) => store.setTheme(v)} options={[{ value: 'auto', label: t('theme.auto') }, { value: 'light', label: t('theme.light') }, { value: 'dark', label: t('theme.dark') }, { value: 'sun', label: t('theme.sun') }]} />
            <p className="note-small">{t('settings.themeNote')}</p>
          </Card>
          <Card>
            <h3 className="subhead">{t('settings.phone.title')}</h3>
            <p>{snap.serverSettings?.hasPhone ? t('settings.phone.saved2', { p: snap.serverSettings.phoneMasked ?? '' }) : t('settings.phone.none')}</p>
            <form onSubmit={savePhone} noValidate>
              <label className="bw-field-label" htmlFor="phone">{t('settings.phone.label')}</label>
              <input id="phone" className="select" type="tel" inputMode="tel" autoComplete="off" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!phoneErr} aria-describedby="phone-h" />
              <p className="note-small" id="phone-h">{t('settings.phone.hint')}</p>
              {phoneErr && <div className="field-error" role="alert">{phoneErr}</div>}
              {phoneOk && <p className="ok-line" role="status"><CircleCheck className="bw-icon" aria-hidden="true" /> {phoneOk}</p>}
              <div className="btn-row">
                <button type="submit" className="bw-btn bw-btn--lg">{t('settings.phone.save')}</button>
                {snap.serverSettings?.hasPhone && <button type="button" className="bw-btn bw-btn--secondary" onClick={() => void removePhone()}>{t('settings.phone.remove')}</button>}
              </div>
            </form>
            <p className="note-small">{t('settings.phone.privacy')}</p>
          </Card>
          <Card>
            <h3 className="subhead">{t('settings.smsLang')}</h3>
            <Segmented label={t('settings.smsLang')} value={settings.smsLang} onChange={(v) => setSettings({ ...settings, smsLang: v })} options={[{ value: 'sw', label: 'Kiswahili' }, { value: 'en', label: 'English' }]} />
            <h3 className="subhead">{t('settings.types')}</h3>
            <p className="note-small">{t('settings.typesNote')}</p>
            {toggles.map((x) => <Switch key={x.k} checked={settings.smsAlertTypes[x.k]} onChange={(v) => setSettings({ ...settings, smsAlertTypes: { ...settings.smsAlertTypes, [x.k]: v } })} label={t(x.label)} />)}
          </Card>
        </div>
        <div className="stack">
          <Card>
            <h3 className="subhead">{t('settings.inbound.title')}</h3>
            <p className="note-small">{t('settings.inbound.note')}</p>
            <form onSubmit={simulate} noValidate>
              <label className="bw-field-label" htmlFor="inb">{t('settings.inbound.label')}</label>
              <input id="inb" className="select mono" value={inbound} maxLength={160} onChange={(e) => setInbound(e.target.value)} autoCapitalize="characters" />
              <p className="note-small">{t('settings.inbound.formats')}</p>
              <button type="submit" className="bw-btn bw-btn--secondary"><Send className="bw-icon" aria-hidden="true" /> {t('settings.inbound.send')}</button>
            </form>
            {inboundErr && <div className="field-error" role="alert">{inboundErr}</div>}
            {inboundRes && (
              <div className="sms-reply" role="status">
                <p className="note-small">{inboundRes.ok ? t('settings.inbound.ok', { n: inboundRes.queued ?? 0 }) : errKey ? t(errKey, { f: inboundRes.field ?? '' }) : ''}</p>
                <div className="sms-bubble">{inboundRes.reply}</div>
                <p className="note-small">{t('settings.inbound.replyNote')}</p>
              </div>
            )}
          </Card>
          <Card well>
            <h3 className="subhead">{t('settings.thresholds')}</h3>
            <p className="note-small">{t('demo.defaultNote')}</p>
            <dl className="kv">
              <div><dt>{t('kind.do')}</dt><dd>{t('th.do', { ok: RULES.do.okMin.toFixed(1), c: RULES.do.criticalBelow.toFixed(1) })}</dd></div>
              <div><dt>{t('kind.temp')}</dt><dd>{t('th.temp', { a: RULES.temp.okMin, b: RULES.temp.okMax, c: RULES.temp.watchMin, d: RULES.temp.watchMax })}</dd></div>
              <div><dt>{t('kind.ph')}</dt><dd>{t('th.ph', { a: RULES.ph.okMin.toFixed(1), b: RULES.ph.okMax.toFixed(1), c: RULES.ph.watchMin.toFixed(1), d: RULES.ph.watchMax.toFixed(1) })}</dd></div>
              <div><dt>{t('th.turnover.label')}</dt><dd>{t('th.turnover', { d: RULES.turnover.deltaC, drop: RULES.turnover.doDrop.toFixed(1), c: RULES.turnover.criticalDo.toFixed(1) })}</dd></div>
              <div><dt>{t('th.weather.label')}</dt><dd>{t('th.weather', { w: RULES.weather.windWatchKmh, c: RULES.weather.windCriticalKmh, r: RULES.weather.rainWatchMm })}</dd></div>
              <div><dt>{t('th.stale.label')}</dt><dd>{t('th.stale', { h: RULES.stale.hours })}</dd></div>
            </dl>
          </Card>
          <Card>
            <h3 className="subhead">{t('settings.consent.title')}</h3>
            <p>{t('settings.consent.body')}</p>
          </Card>
          <Card>
            <h3 className="subhead">{t('settings.reset.title')}</h3>
            <p className="note-small">{t('settings.reset.note')}</p>
            <button type="button" className="bw-btn bw-btn--destructive" onClick={() => setConfirm(true)}><Trash2 className="bw-icon" aria-hidden="true" /> {t('settings.reset.button')}</button>
          </Card>
        </div>
      </div>
      <Sheet open={confirm} title={t('settings.reset.title')} onClose={() => setConfirm(false)}>
        <p>{t('settings.reset.confirm')}</p>
        <div className="btn-row">
          <button type="button" className="bw-btn bw-btn--destructive bw-btn--lg" onClick={async () => { await store.resetDemo(); setConfirm(false); }}>{t('settings.reset.yes')}</button>
          <button type="button" className="bw-btn bw-btn--secondary bw-btn--lg" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
        </div>
      </Sheet>
    </div>
  );
}

// ------------------------------------------------------------------ SMS
/** Sample values so each template preview reads like a real message. */
const sampleFor = (id: string) => {
  const low = id.includes('ph') ? { value: 5.4 } : id.includes('temp') ? { value: 33.5 } : id.startsWith('wind') ? { value: 41 } : id.startsWith('rain') ? { value: 12 } : { value: 3.8 };
  return { cage: 3, delta: 3.4, hours: 30, low: id.includes('ph'), summary: 'OKS 5.2 JOTO 27.5', ...low };
};
export function SmsScreen() {
  const t = useT();
  const s = useApp();
  const lang = useLang();
  const f = useFmt(s.now);
  const [log, setLog] = useState<SmsLogEntry[] | null>(null);
  useEffect(() => { http.get<{ log: SmsLogEntry[] }>('/api/sms/log').then((r) => setLog(r.log)).catch(() => setLog(null)); }, [s.snap?.pending.sms, s.snap?.lastTestSms?.at]);
  const ids: SmsTemplateId[] = ALL_TEMPLATE_IDS.filter((x) => x !== 'inbound_ok' && x !== 'inbound_error');
  return (
    <div className="screen">
      <PageHeader title={t('sms.title')} sub={<span>{t('sms.sub')} <DemoChip /></span>} />
      <OfflineBanner />
      <div className="detail-grid">
        <div className="stack">
          <Card>
            <h3 className="subhead">{t('sms.how.title')}</h3>
            <ul className="plain-list">
              <li>{t('sms.how.1')}</li>
              <li>{t('sms.how.2')}</li>
              <li>{t('sms.how.3')}</li>
            </ul>
            <a className="bw-btn bw-btn--secondary" href={href('farmer', 'settings')}>{t('nav.settings')}</a>
          </Card>
          <Card>
            <h3 className="subhead">{t('sms.report.title')}</h3>
            <p className="note-small">{t('sms.report.note')}</p>
            <div className="sms-bubble mono">RIPOTI K3 OKS 5.2 JOTO 27.5 PH 7.4</div>
            <div className="sms-bubble mono">REPORT C3 DO 5.2 T 27.5 PH 7.4</div>
            <p className="note-small">{t('sms.report.fields')}</p>
          </Card>
          <Card well>
            <h3 className="subhead">{t('sms.ussd.title')}</h3>
            <p>{t('sms.ussd.body')}</p>
          </Card>
        </div>
        <div className="stack">
          <Card>
            <h3 className="subhead">{t('sms.templates.title')}</h3>
            <p className="note-small">{t('sms.templates.note', { max: SMS_MAX })} {t('settings.swReview')}</p>
            <ul className="tpl-list">
              {ids.map((id) => {
                const text = renderSms(id, lang, sampleFor(id));
                return <li key={id}><div className="sms-bubble">{text}</div><span className="note-small">{smsLength(text)}/{SMS_MAX} {isGsm7(text) ? 'GSM-7' : ''}</span></li>;
              })}
            </ul>
          </Card>
          <Card>
            <h3 className="subhead">{t('sms.log.title')}</h3>
            {!log || log.length === 0 ? <p className="note-small">{t('sms.log.none')}</p> : (
              <ul className="plain-list">
                {log.slice(0, 8).map((e) => (
                  <li key={e.id}>
                    {f.dateTime(Date.parse(e.at))} {'·'} {e.kind} {'·'} <strong>{t(`sms.state.${e.state}` as Key)}</strong>
                    {/* Delivery is a separate fact from Sent, and only shown once Beem has actually reported. */}
                    {e.state === 'sent' && <> {'·'} {t('sms.delivery.label')}: <strong>{e.delivery ? t(`sms.delivery.${e.delivery.state}` as Key) : t('sms.delivery.none')}</strong></>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
export { DEFAULT_SETTINGS, nowMs };
