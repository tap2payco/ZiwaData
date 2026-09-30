/**
 * Open-Meteo Real Data integration for Mwanza Gulf / Lake Victoria.
 * Coordinates: Latitude -2.5167, Longitude 32.9000 (Mwanza, Tanzania).
 * 
 * 100% Public Open Data — NO API Key or Bearer Token required!
 */

export interface OpenMeteoLive {
  fetchedAt: string;
  latitude: number;
  longitude: number;
  elevation: number;
  temperature: number; // °C
  humidity: number; // %
  surfacePressure: number; // hPa
  windSpeed: number; // km/h
  windGusts: number; // km/h
  windDirection: number; // degrees
  precipitation: number; // mm
  isDay: boolean;
  // Derived Lake Victoria metrics computed from real live lake weather
  estimatedDO: number; // mg/L (estimated DO saturation for Lake Victoria altitude 1134m)
  turnoverRisk: 'low' | 'moderate' | 'high';
  weatherDesc: string;
}

export interface HourlyPoint {
  time: string;
  temp: number;
  windSpeed: number;
  pressure: number;
  rain: number;
}

/**
 * Fetch real live weather and environmental conditions for Mwanza Gulf from Open-Meteo API.
 */
export async function fetchLiveLakeData(): Promise<{ live: OpenMeteoLive; hourly: HourlyPoint[] }> {
  const lat = -2.5167;
  const lon = 32.9000;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,is_day&hourly=temperature_2m,surface_pressure,wind_speed_10m,precipitation&timezone=Africa%2FDar_es_Salaam&forecast_days=2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo API HTTP error: ${res.status}`);
  const data = await res.json();

  const curr = data.current || {};
  const temp = Number(curr.temperature_2m ?? 25.5);
  const humidity = Number(curr.relative_humidity_2m ?? 75);
  const pressure = Number(curr.surface_pressure ?? 886); // ~886 hPa at 1134m altitude
  const windSpeed = Number(curr.wind_speed_10m ?? 12);
  const windGusts = Number(curr.wind_gusts_10m ?? 18);
  const windDirection = Number(curr.wind_direction_10m ?? 140);
  const precipitation = Number(curr.precipitation ?? 0);
  const isDay = Boolean(curr.is_day ?? 1);

  // Dissolved Oxygen Saturation formula adjusted for Lake Victoria altitude (~1134m, ~886 hPa):
  // Saturation DO at sea level 25°C is ~8.24 mg/L. Altitude factor 886/1013 ~0.874 => DO ~ 7.2 mg/L.
  const baseDoSeaLevel = 14.652 - 0.41022 * temp + 0.007991 * Math.pow(temp, 2) - 0.000077774 * Math.pow(temp, 3);
  const altitudeFactor = pressure / 1013.25;
  const estimatedDO = Math.round((baseDoSeaLevel * altitudeFactor) * 10) / 10;

  // Turnover risk increases with high wind gusts (> 25 km/h) or low surface pressure drops
  let turnoverRisk: 'low' | 'moderate' | 'high' = 'low';
  if (windGusts > 32 || (pressure < 880 && windSpeed > 20)) {
    turnoverRisk = 'high';
  } else if (windGusts > 22 || windSpeed > 15) {
    turnoverRisk = 'moderate';
  }

  let weatherDesc = isDay ? 'Clear Skies over Mwanza Gulf' : 'Clear Night over Lake Victoria';
  if (precipitation > 2.0) weatherDesc = 'Heavy Rain & Storm Warning';
  else if (precipitation > 0.1) weatherDesc = 'Light Rain Shower';
  else if (windGusts > 28) weatherDesc = 'Strong Winds & Choppy Lake Water';

  const hourlyTimes: string[] = data.hourly?.time || [];
  const hourlyTemps: number[] = data.hourly?.temperature_2m || [];
  const hourlyWind: number[] = data.hourly?.wind_speed_10m || [];
  const hourlyPress: number[] = data.hourly?.surface_pressure || [];
  const hourlyRain: number[] = data.hourly?.precipitation || [];

  const hourly: HourlyPoint[] = hourlyTimes.slice(0, 24).map((t, i) => ({
    time: t.split('T')[1] || t,
    temp: hourlyTemps[i] ?? temp,
    windSpeed: hourlyWind[i] ?? windSpeed,
    pressure: hourlyPress[i] ?? pressure,
    rain: hourlyRain[i] ?? 0,
  }));

  return {
    live: {
      fetchedAt: new Date().toISOString(),
      latitude: lat,
      longitude: lon,
      elevation: data.elevation ?? 1134,
      temperature: temp,
      humidity,
      surfacePressure: pressure,
      windSpeed,
      windGusts,
      windDirection,
      precipitation,
      isDay,
      estimatedDO,
      turnoverRisk,
      weatherDesc,
    },
    hourly,
  };
}
