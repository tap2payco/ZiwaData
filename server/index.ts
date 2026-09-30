import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { beemConfigured } from './sms/beem';
import { boxConfigFromEnv } from './box/adapter';
import { createStore, migrateIfNeeded } from './store';
import { authRequired } from './auth/auth';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(here, 'data');
const store = createStore({ databaseUrl: process.env.DATABASE_URL, dataDir });
const { app } = createApp({ dataDir, store });

const dist = join(root, 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  // Service worker and index must never be cached hard, or an update never reaches the phone.
  const noCache = (res: express.Response) => res.setHeader('Cache-Control', 'no-cache');
  app.use(express.static(dist, { setHeaders: (res, p) => { if (/(sw\.js|index\.html|manifest\.webmanifest|registerSW\.js)$/.test(p) || /workbox-.*\.js$/.test(p)) noCache(res); } }));
  app.get(/^(?!\/api\/).*/, (_req, res) => { noCache(res); res.sendFile(join(dist, 'index.html')); });
}

// Apply any migrations this database has not seen. Does nothing for the JSON store.
const applied = await migrateIfNeeded(store);
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);

const shutdown = async () => { await store.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

app.listen(port, '0.0.0.0', () => {
  // Startup summary only. No secrets, no phone numbers.
  const box = boxConfigFromEnv(process.env);
  console.log(`API on http://localhost:${port}`);
  console.log(`Store: ${store.describe()}`);
  if (authRequired(process.env)) {
    console.log('Sign-in: REQUIRED (phone number plus a one-time code by SMS)');
    if (!process.env.AUTH_SECRET?.trim()) {
      console.log('  WARNING: AUTH_SECRET is not set. A random one is used, so every restart signs everyone out.');
    }
  } else {
    console.log('Sign-in: OFF (open demo). Set AUTH_REQUIRED=1 to enforce sign-in and roles.');
  }
  console.log(`SMS mode: ${beemConfigured(process.env) ? 'Beem credentials set (not verified until a send succeeds)' : 'DRY-RUN (no Beem credentials)'}`);
  console.log(`Box mode: ${box.apiKey || box.bearer ? 'credentials set (Live only after a successful test call)' : 'demo (no key or token)'}`);
  if (process.env.NODE_ENV === 'production' && !existsSync(dist)) console.log('No dist/ folder: run "npm run build" first to serve the web app from here.');
});
