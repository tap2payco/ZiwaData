/** ALL thresholds are demo defaults, kept in this ONE object. Confirm with fisheries experts before real use. */
export const RULES = {
  do: { okMin: 5.0, criticalBelow: 4.0 },
  temp: { okMin: 24, okMax: 31, watchMin: 20, watchMax: 34 },
  ph: { okMin: 6.5, okMax: 9.0, watchMin: 6.0, watchMax: 9.5 },
  turnover: { deltaC: 3, doDrop: 1.0, doReadings: 3, criticalDo: 4.0 },
  weather: { windWatchKmh: 30, windCriticalKmh: 45, rainWatchMm: 20 },
  stale: { hours: 24 },
  feeding: { resumeDo: 5.5, resumeReadings: 2 },
  plausible: { do: [0, 20], temp: [10, 40], ph: [4, 11], tempDeep: [10, 40] } as Record<string, [number, number]>,
} as const;

export const SCORE = {
  windowDays: 30,
  completenessMax: 40,
  consistencyMax: 20, // 10 for "no gap longer than gapDays" + 10 for plausible values
  verificationMax: 20,
  outcomesMax: 20, // 12 for DO share + 8 for mortality not rising
  outcomesDoMax: 12,
  outcomesMortalityMax: 8,
  gapDays: 3,
  doOkMg: 5,
  doShareTarget: 0.9,
  mortalityRiseRatio: 1.25,
  mortalityRiseMinAbs: 5,
  trancheMinScore: 60,
  trancheMaxAgeDays: 3,
} as const;

export const DEMO_DEFAULT_NOTE = 'Demo default, confirm with fisheries experts';

/** This build ships demo data only. Every record created here is labelled demo. */
export const DEMO_BUILD = true;

/** Demo point for the weather call (inside the Box's allowed range lat -5.1..2.5, lon 28.95..36.7). */
export const DEMO_POINT = { lat: -2.52, lon: 32.9 } as const;
export const BOX_RANGE = { latMin: -5.1, latMax: 2.5, lonMin: 28.95, lonMax: 36.7 } as const;

export const ZERO_HASH = '0'.repeat(64);
