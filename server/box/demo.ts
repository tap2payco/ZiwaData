import { demoForecast } from '../../src/core/forecast';
import type { Forecast } from '../../src/core/types';

/** DEMO device list in an ASSUMED shape (the real WaziCloud proxy schema is undocumented). 2 water stations + 1 weather station. */
export function demoDevicesPayload(now: number) {
  const ts = new Date(now - 35 * 60_000).toISOString();
  return {
    devices: [
      { id: 'demo-ws-1', name: 'Demo water station 1', type: 'water_station', location: { lat: -2.52, lon: 32.9 }, last_seen: ts, latest: { dissolved_oxygen_mgl: 6.4, water_temperature_c: 27.6, ph: 7.6, timestamp: ts } },
      { id: 'demo-ws-2', name: 'Demo water station 2', type: 'water_station', location: { lat: -2.521, lon: 32.901 }, last_seen: ts, latest: { dissolved_oxygen_mgl: 3.8, water_temperature_c: 27.9, ph: 7.5, timestamp: ts } },
      { id: 'demo-wx-1', name: 'Demo weather station', type: 'weather_station', location: { lat: -2.52, lon: 32.9 }, last_seen: ts, latest: { wind_speed_kmh: 41, rain_mm: 12, air_temperature_c: 29, timestamp: ts } },
    ],
  };
}
export const demoWeather = (now: number): Forecast => demoForecast(now);
