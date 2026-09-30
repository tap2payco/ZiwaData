import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './json';
import { PgStore } from './pg';
import type { AppStore } from './types';

export { JsonStore } from './json';
export { PgStore } from './pg';
export * from './types';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'db', 'migrations');

export interface Migration { name: string; sql: string }
/** Every .sql file in server/db/migrations, in filename order. Numbered 001, 002, ... so order is obvious. */
export function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/**
 * Pick a store. `DATABASE_URL` set means Postgres; otherwise the JSON file, which keeps the demo
 * runnable with nothing installed. Nothing else in the server knows which one it got.
 */
export function createStore(opts: { databaseUrl?: string; dataDir: string }): AppStore {
  const url = opts.databaseUrl?.trim();
  return url ? new PgStore(url) : new JsonStore(opts.dataDir);
}

/** Applies any migrations the database has not seen. No-op for the JSON store. */
export async function migrateIfNeeded(store: AppStore): Promise<string[]> {
  return store instanceof PgStore ? store.migrate(readMigrations()) : [];
}
