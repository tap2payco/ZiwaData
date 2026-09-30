import { HOUR_MS } from './format';
import type { Forecast } from './types';

/** Demo forecast: one storm-forecast alert (wind Watch). Clearly Demo data; used when the server has no Box key. */
export function demoForecast(now: number): Forecast {
  const issued = Math.floor(now / (3 * HOUR_MS)) * 3 * HOUR_MS;
  return { source: 'demo', issuedAt: new Date(issued).toISOString(), windKmh: 41, rainMm: 12, tempMaxC: 29 };
}
