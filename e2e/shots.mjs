// Takes the required screenshots at phone (390x844) and desktop (1280x800). Run: npm run build && npm run shots
import { mkdirSync } from 'node:fs';
import { BASE, NOW, launch, ready, startServer, wait } from './lib.mjs';

const OUT = new URL('../../deliverables/shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const VIEWS = [{ id: 'phone', width: 390, height: 844, mobile: true }, { id: 'desktop', width: 1280, height: 800, mobile: false }];
const q = (extra = '') => `/?now=${NOW}&dev=1${extra}`;

const SHOTS = [
  { name: '01-home-light', role: 'farmer', hash: 'home', theme: 'light' },
  { name: '02-cages', role: 'farmer', hash: 'cages', theme: 'light' },
  { name: '03-cage3-low-oxygen', role: 'farmer', hash: 'cages/farm-demo-c3', theme: 'light' },
  { name: '04-record-offline', role: 'farmer', hash: 'record', theme: 'light', offline: true },
  { name: '05-alerts', role: 'farmer', hash: 'alerts', theme: 'light' },
  { name: '06-record-score', role: 'farmer', hash: 'score', theme: 'light' },
  { name: '07-lender-portfolio', role: 'lender', hash: 'portfolio', theme: 'light' },
  { name: '08-lender-borrower-juma', role: 'lender', hash: 'b/farm-juma', theme: 'light' },
  { name: '09-lender-borrower-salma-chain-break', role: 'lender', hash: 'b/farm-salma', theme: 'light' },
  { name: '10-extension-attest', role: 'extension', hash: 'attest', theme: 'light' },
  { name: '11-data-sources', role: 'farmer', hash: 'sources', theme: 'light' },
  { name: '12-settings', role: 'farmer', hash: 'settings', theme: 'light' },
  { name: '13-home-night', role: 'farmer', hash: 'home', theme: 'dark' },
  { name: '14-home-sun', role: 'farmer', hash: 'home', theme: 'sun' },
  { name: '15-home-english', role: 'farmer', hash: 'home', theme: 'light', lang: 'en' },
  { name: '16-sms-page', role: 'farmer', hash: 'sms', theme: 'light' },
];

const server = await startServer();
const browser = await launch();
let failures = 0;
try {
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1, isMobile: v.mobile, hasTouch: v.mobile, serviceWorkers: 'block' });
    for (const s of SHOTS) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.addInitScript(([theme, lang, role]) => { try { localStorage.setItem('app.theme', theme); localStorage.setItem('app.lang', lang); localStorage.setItem('app.role', role); } catch {} }, [s.theme, s.lang ?? 'sw', s.role]);
      await page.goto(`${BASE}${q(s.offline ? '&offline=1' : '')}#/${s.role}/${s.hash}`);
      await ready(page);
      await wait(500);
      const leftover = await page.evaluate(() => (document.body.innerText.match(/\{[a-zA-Z]+\}|\b(?:[a-z]+\.){1,3}[a-z_]+\b(?=\s|$)/g) || []).filter((x) => !/^\{(full_)?path\}$/.test(x)).filter((x) => /^\{|^(nav|kind|status|alert|score|record|sms|home|cages|src|chain|bank|hold|lender|tranche|ext|pack|settings|sources|depth|chart|feed|advice)\./.test(x)));
      if (leftover.length) { console.log(`  UNTRANSLATED/UNFILLED in ${v.id}-${s.name}:`, leftover.slice(0, 5)); failures++; }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) { console.log(`  HORIZONTAL SCROLL ${overflow}px in ${v.id}-${s.name}`); failures++; }
      if (errors.length) { console.log(`  console errors in ${v.id}-${s.name}:`, errors.slice(0, 3)); failures++; }
      // Grow the viewport to the page height so the fixed nav sits at the true bottom/side instead of mid-page.
      const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, window.innerHeight));
      await page.setViewportSize({ width: v.width, height: Math.min(h, 4000) });
      await wait(300);
      await page.screenshot({ path: `${OUT}${v.id}-${s.name}.png` });
      await page.close();
      console.log('shot', `${v.id}-${s.name}.png`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.child.kill();
}
console.log(failures ? `DONE with ${failures} issue(s)` : 'DONE, no issues flagged');
process.exit(failures ? 1 : 0);
