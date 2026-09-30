// Shared helpers for the Playwright scripts. Uses a browser already on the machine; nothing is downloaded.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync, rmSync } from 'node:fs';

// CHROMIUM_PATH always wins. Otherwise try the usual places, so the scripts run on a plain
// Linux box without anyone having to know where Chromium landed.
const CHROMIUM_CANDIDATES = [
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const hit = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
  if (hit) return hit;
  throw new Error(
    'No Chromium or Chrome found. Set CHROMIUM_PATH to a browser binary. Looked in:\n  ' +
      CHROMIUM_CANDIDATES.join('\n  '),
  );
}
export const CHROMIUM = findChromium();
export const NOW = '2026-09-29T06:10:00Z'; // 09:10 EAT, so screenshots are reproducible
export const PORT = Number(process.env.E2E_PORT || 8790);
export const BASE = `http://127.0.0.1:${PORT}`;

/** Starts the production server (serving dist/) with NO .env and a throwaway data dir. */
export async function startServer(extraEnv = {}) {
  const dataDir = 'server/data/e2e';
  rmSync(dataDir, { recursive: true, force: true });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR: dataDir, ...extraEnv };
  let inUse = false;
  try { await fetch(`${BASE}/api/health`); inUse = true; } catch { /* port is free */ }
  if (inUse) throw new Error(`port ${PORT} is already in use by another server; stop it first`);
  // detached + group kill: "npx" would otherwise leave the real server running after the script ends
  const child = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return { child, out: () => out }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('server did not start: ' + out);
}
export const launch = () => chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function ready(page) {
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.splash'), null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await wait(400);
}
