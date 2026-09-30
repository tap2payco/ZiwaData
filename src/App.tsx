import { Bell, Briefcase, ClipboardCheck, Database, Fish, Gauge, House, ListChecks, Menu, MessageSquare, Pencil, QrCode as QrCodeIcon, Settings as SettingsIcon, ShieldCheck, Users, WifiOff, Wifi, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BRAND } from './brand';
import { devToolsVisible } from './data/net';
import type { Role } from './data/prefs';
import { store, useApp, useViews } from './data/store';
import { LangContext, useT, type Key } from './i18n';
import { DEFAULT_PAGE, href, navigate, parseHash, useHash } from './router';
import { HomeScreen, CagesScreen, CageDetailScreen, RecordScreen, AlertsScreen, ScoreScreen } from './screens/farmer';
import { LenderPortfolioScreen, LenderDetailScreen } from './screens/lender';
import { ExtensionFarmsScreen, AttestScreen } from './screens/extension';
import { SourcesScreen, SettingsScreen, SmsScreen } from './screens/common';
import { PackScreen } from './screens/pack';
import { LandingScreen } from './screens/landing';
import { AuthScreen } from './screens/auth';
import { DemoChip } from './ui/bits';
import { Segmented, Sheet } from './ui/controls';
import { ShareModal } from './ui/ShareModal';

export const Wordmark = () => (
  <span className="wordmark inline-flex items-center gap-2">
    <img src="/logo/Asset 2.svg" alt="Ziwa Data" className="h-7 w-auto ziwa-brand-logo" style={{ height: '28px' }} />
    <span>{BRAND.name}</span>
  </span>
);

interface NavItem { page: string; icon: LucideIcon; label: Key; badge?: 'alerts' }
const NAV: Record<Role, NavItem[]> = {
  farmer: [
    { page: 'home', icon: House, label: 'nav.home' },
    { page: 'cages', icon: Fish, label: 'nav.cages' },
    { page: 'record', icon: Pencil, label: 'nav.record' },
    { page: 'alerts', icon: Bell, label: 'nav.alerts', badge: 'alerts' },
    { page: 'score', icon: Gauge, label: 'nav.score' },
  ],
  lender: [
    { page: 'portfolio', icon: Briefcase, label: 'nav.portfolio' },
    { page: 'sources', icon: Database, label: 'nav.sources' },
    { page: 'settings', icon: SettingsIcon, label: 'nav.settings' },
  ],
  extension: [
    { page: 'farms', icon: Users, label: 'nav.farms' },
    { page: 'attest', icon: ClipboardCheck, label: 'nav.attest' },
    { page: 'sources', icon: Database, label: 'nav.sources' },
    { page: 'settings', icon: SettingsIcon, label: 'nav.settings' },
  ],
};
const MORE: Record<Role, NavItem[]> = {
  farmer: [
    { page: 'sms', icon: MessageSquare, label: 'nav.sms' },
    { page: 'sources', icon: Database, label: 'nav.sources' },
    { page: 'settings', icon: SettingsIcon, label: 'nav.settings' },
  ],
  lender: [],
  extension: [],
};
const ROLE_ICON: Record<Role, LucideIcon> = { farmer: Fish, lender: Briefcase, extension: ShieldCheck };

function RoleSwitcher({ onDone }: { onDone?: () => void }) {
  const s = useApp();
  const t = useT();
  return (
    <div className="role-switch">
      <div className="bw-field-label">{t('role.label')}</div>
      <div role="radiogroup" aria-label={t('role.label')} className="role-list">
        {(['farmer', 'lender', 'extension'] as Role[]).map((r) => {
          const I = ROLE_ICON[r];
          return (
            <button key={r} type="button" role="radio" aria-checked={s.role === r} className="role-opt" onClick={() => { store.setRole(r); navigate(r, DEFAULT_PAGE[r]); onDone?.(); }}>
              <I className="bw-icon" aria-hidden="true" />
              <span>
                <strong>{t(`role.${r}` as Key)}</strong>
                <span className="note-small">{t(`role.${r}.desc` as Key)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="note-small role-note">{t('role.noSignIn')}</p>
    </div>
  );
}

function Prefs() {
  const s = useApp();
  const t = useT();
  return (
    <div className="prefs">
      <div>
        <div className="bw-field-label">{t('settings.language')}</div>
        <Segmented label={t('settings.language')} value={s.lang} onChange={(v) => store.setLang(v)} options={[{ value: 'sw', label: 'Kiswahili' }, { value: 'en', label: 'English' }]} />
      </div>
      <div>
        <div className="bw-field-label">{t('settings.theme')}</div>
        <Segmented label={t('settings.theme')} value={s.theme} onChange={(v) => store.setTheme(v)} options={[{ value: 'auto', label: t('theme.auto') }, { value: 'light', label: t('theme.light') }, { value: 'dark', label: t('theme.dark') }, { value: 'sun', label: t('theme.sun') }]} />
      </div>
    </div>
  );
}

function Shell({ role, page, children }: { role: Role; page: string; children: React.ReactNode }) {
  const s = useApp();
  const t = useT();
  const views = useViews();
  const [more, setMore] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const activeCount = views['farm-demo']?.active.length ?? 0;
  const items = NAV[role];
  const navPage = role === 'lender' && (page === 'b' || page === 'pack') ? 'portfolio' : role === 'farmer' && page === 'pack' ? 'score' : page;
  const dev = devToolsVisible();
  const NavLink = ({ it }: { it: NavItem }) => {
    const I = it.icon;
    const current = navPage === it.page || (role === 'farmer' && it.page === 'cages' && page === 'cages');
    return (
      <a className="nav-item" href={href(role, it.page)} aria-current={current ? 'page' : undefined}>
        <span className="nav-item__pill bw-tab__pill">
          <I className="bw-icon" aria-hidden="true" />
          {it.badge === 'alerts' && activeCount > 0 && <span className="nav-badge" aria-label={t('nav.alertsCount', { n: activeCount })}>{activeCount}</span>}
        </span>
        <span className="nav-item__label">{t(it.label)}</span>
      </a>
    );
  };
  return (
    <div className="shell">
      <nav className="nav" aria-label={t('nav.main')}>
        <div className="nav-brand"><Wordmark /></div>
        <div className="nav-items">{items.map((it) => <NavLink key={it.page} it={it} />)}</div>
        <div className="nav-more">
          <div className="nav-sep" />
          {MORE[role].map((it) => <NavLink key={it.page} it={it} />)}
        </div>
        <div className="nav-foot">
          <RoleSwitcher />
          <Prefs />
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <div className="topbar__brand">
            <Wordmark />
            <span className="note-small topbar__role">{t(`role.${role}` as Key)}</span>
          </div>
          <div className="topbar__right">
            <button
              type="button"
              className="bw-btn bw-btn--small inline-flex items-center gap-1.5 font-bold cursor-pointer"
              style={{ textDecoration: 'none', fontSize: '12px', padding: '5px 12px', borderRadius: '20px', backgroundColor: '#0A5160', color: '#FFFFFF', border: 'none' }}
              onClick={() => setShareOpen(true)}
              title="Share demo over Wi-Fi / Scan QR Code"
            >
              <QrCodeIcon size={14} />
              <span>Wi-Fi QR</span>
            </button>
            <a href="#/auth/signin" className="bw-btn bw-btn--small bw-btn--secondary" style={{ textDecoration: 'none', fontSize: '13px', padding: '4px 10px', borderRadius: '20px' }}>
              Sign In
            </a>
            <DemoChip />
            {dev && (
              <button type="button" className="bw-iconbtn" aria-pressed={s.simOffline} aria-label={t('dev.offlineToggle')} title={t('dev.offlineToggle')} onClick={() => store.setOffline(!s.simOffline)}>
                {s.simOffline ? <WifiOff className="bw-icon" /> : <Wifi className="bw-icon" />}
              </button>
            )}
            <button type="button" className="bw-iconbtn topbar__menu" aria-label={t('more.open')} onClick={() => setMore(true)}>
              <Menu className="bw-icon" />
            </button>
          </div>
        </header>
        <main className="content" id="main" tabIndex={-1}>{children}</main>
      </div>
      <Sheet open={more} title={t('more.title')} onClose={() => setMore(false)}>
        <RoleSwitcher onDone={() => setMore(false)} />
        <ul className="bw-list more-list">
          {MORE[role].map((it) => {
            const I = it.icon;
            return (
              <li key={it.page}>
                <a className="bw-row" href={href(role, it.page)} onClick={() => setMore(false)}>
                  <I className="bw-icon" aria-hidden="true" />
                  <span className="bw-row__main"><span className="bw-row__title">{t(it.label)}</span></span>
                </a>
              </li>
            );
          })}
        </ul>
        <Prefs />
        <p className="note-small">{t('more.foot')}</p>
      </Sheet>

      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}

function Screen({ role, page, params }: { role: Role; page: string; params: string[] }) {
  if (page === 'sources') return <SourcesScreen />;
  if (page === 'settings') return <SettingsScreen />;
  if (role === 'farmer') {
    switch (page) {
      case 'cages': return params[0] ? <CageDetailScreen cageId={params[0]} /> : <CagesScreen />;
      case 'record': return <RecordScreen initialCage={params[0]} />;
      case 'alerts': return <AlertsScreen />;
      case 'score': return <ScoreScreen />;
      case 'pack': return <PackScreen farmId="farm-demo" role="farmer" />;
      case 'sms': return <SmsScreen />;
      default: return <HomeScreen />;
    }
  }
  if (role === 'lender') {
    if (page === 'b' && params[0]) return <LenderDetailScreen farmId={params[0]} />;
    if (page === 'pack' && params[0]) return <PackScreen farmId={params[0]} role="lender" />;
    return <LenderPortfolioScreen />;
  }
  return page === 'attest' ? <AttestScreen initialFarm={params[0]} /> : <ExtensionFarmsScreen />;
}

export function App() {
  const s = useApp();
  const hash = useHash();
  useEffect(() => { void store.start(); }, []);
  useEffect(() => { document.documentElement.lang = s.lang; }, [s.lang]);
  useEffect(() => {
    if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
      window.location.replace('#/landing');
    }
  }, []);
  const route = parseHash(hash, s.role);
  // The URL decides the role, so a shared link opens in the right view.
  useEffect(() => { if (route.role !== s.role) store.setRole(route.role); }, [route.role, s.role]);

  if (s.error) {
    return (
      <LangContext.Provider value={s.lang}>
        <div className="splash"><Wordmark /><p className="splash__msg" role="alert">{s.lang === 'sw' ? 'Hifadhi ya simu haipatikani. Jaribu dirisha la kawaida, si la faragha.' : 'Storage on this device is not available. Try a normal window, not a private one.'}</p><p className="note-small">{s.error}</p></div>
      </LangContext.Provider>
    );
  }
  if (!s.ready) {
    return (
      <LangContext.Provider value={s.lang}>
        <div className="splash" role="status"><Wordmark /><p className="splash__msg">{s.lang === 'sw' ? 'Inaandaa data ya majaribio...' : 'Preparing demo data...'}</p></div>
      </LangContext.Provider>
    );
  }
  if (route.page === 'landing') {
    return (
      <LangContext.Provider value={s.lang}>
        <LandingScreen />
      </LangContext.Provider>
    );
  }
  if (route.page === 'auth') {
    const mode = route.params[0] === 'signup' ? 'signup' : route.params[0] === 'forgot-password' ? 'forgot-password' : 'signin';
    return (
      <LangContext.Provider value={s.lang}>
        <AuthScreen initialMode={mode} />
      </LangContext.Provider>
    );
  }

  return (
    <LangContext.Provider value={s.lang}>
      <Shell role={route.role} page={route.page}>
        <Screen role={route.role} page={route.page} params={route.params} />
      </Shell>
    </LangContext.Provider>
  );
}
