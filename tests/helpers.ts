import { generateWorld, type DemoWorld } from '../src/core/seed';

/** 29 Sep 2026 09:10 East Africa Time. */
export const NOW = Date.parse('2026-09-29T06:10:00Z');
let world: Promise<DemoWorld> | null = null;
export const getWorld = () => (world ??= generateWorld(NOW));
