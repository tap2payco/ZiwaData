import { describe, expect, it, vi } from 'vitest';
import { mapDevicePayload, mapWeatherPayload, BOX_ROUTES, boxPointValid } from '../server/box/adapter';
import { demoDevicesPayload } from '../server/box/demo';
import {
  normalizeRecipient, sendSMS, sendSMSWithRetry, beemConfigured, checkBalance,
  getDeliveryReport, isPermanentFailure, parseDlrCallback, senderIdIssue, BEEM_DLR_URL, DLR_STATUS,
} from '../server/sms/beem';
import { maskPhone, normalizeTzPhone } from '../src/core/phone';

describe('mapDevicePayload (assumed shape, defensive)', () => {
  const NOW = Date.parse('2026-09-29T06:10:00Z');
  it('maps the demo device list into sensor readings and a weather record', () => {
    const m = mapDevicePayload(demoDevicesPayload(NOW), { demo: true, farmId: 'farm-demo', deviceCageMap: { 'demo-ws-1': 'farm-demo-c1' } });
    expect(m.devices).toHaveLength(3);
    expect(m.readings).toHaveLength(6);
    expect(m.readings.every((r) => r.source === 'sensor' && r.demo && r.deviceId)).toBe(true);
    expect(m.readings.find((r) => r.deviceId === 'demo-ws-1' && r.kind === 'do')).toMatchObject({ value: 6.4, unit: 'mg/L', cageId: 'farm-demo-c1' });
    expect(m.readings.find((r) => r.deviceId === 'demo-ws-2')!.cageId).toBe('unassigned');
    expect(m.weather).toEqual([{ deviceId: 'demo-wx-1', windKmh: 41, rainMm: 12, tempC: 29 }]);
  });
  it('accepts alternative wrappers and key names', () => {
    const m = mapDevicePayload({ items: [{ device_id: 'x', type: 'water', data: { DO: '5.5', water_temp: 26, ph_value: 7.1, time: 1790000000 } }] }, { demo: false });
    expect(m.readings.map((r) => [r.kind, r.value])).toEqual([['do', 5.5], ['temp', 26], ['ph', 7.1]]);
    expect(m.readings[0]!.ts).toBe(new Date(1790000000 * 1000).toISOString());
  });
  it('skips what it cannot parse instead of inventing values', () => {
    for (const junk of [null, undefined, 'x', 42, {}, [], { devices: 'no' }, { devices: [null, 1, 'a', {}] }]) {
      const m = mapDevicePayload(junk, { demo: false });
      expect(m.readings).toEqual([]);
    }
    const noTs = mapDevicePayload([{ id: 'a', type: 'water', latest: { do: 6 } }], { demo: false });
    expect(noTs.readings).toEqual([]);
    expect(noTs.skipped).toBe(1);
    const noValues = mapDevicePayload([{ id: 'a', type: 'water', latest: { timestamp: '2026-09-29T05:00:00Z' } }], { demo: false });
    expect(noValues.readings).toEqual([]);
    expect(noValues.devices).toHaveLength(1);
  });
});

describe('mapWeatherPayload (UNVERIFIED mapping)', () => {
  const NOW = Date.parse('2026-09-29T06:10:00Z');
  it('converts wind only when the payload states its unit', () => {
    const a = mapWeatherPayload({ data_day: { windspeed_max: [8.5], precipitation: [12] }, units: { windspeed: 'ms-1', precipitation: 'mm' } }, NOW);
    expect(a.forecast).toMatchObject({ source: 'live', windKmh: 30.6, rainMm: 12, unverified: true });
    const b = mapWeatherPayload({ windspeed_max: [40], precipitation: [12] }, NOW);
    expect(b.forecast.windKmh).toBeNull();
    expect(b.forecast.rainMm).toBeNull();
    expect(b.raw).toMatchObject({ wind: 40, windUnit: null, rain: 12 });
  });
  it('unknown shapes give nulls, never zeros', () => {
    const m = mapWeatherPayload({ hello: 'world' }, NOW);
    expect(m.forecast).toMatchObject({ windKmh: null, rainMm: null, tempMaxC: null });
  });
});

describe('Box route table and range', () => {
  it('encodes what the public spec confirms', () => {
    const r = (id: string) => BOX_ROUTES.find((x) => x.id === id)!;
    expect(r('devices').auth).toEqual(['bearer']);
    expect(r('water').auth).toEqual(expect.arrayContaining(['bearer', 'api_key', 'basic']));
    expect(r('api_keys').auth).toEqual(['basic']);
    expect(r('auth_me').auth).toEqual(['bearer']);
  });
  it('the demo point is inside the Box range', () => {
    expect(boxPointValid(-2.52, 32.9)).toBe(true);
    expect(boxPointValid(-5.2, 32.9)).toBe(false);
    expect(boxPointValid(2.6, 32.9)).toBe(false);
    expect(boxPointValid(0, 28.9)).toBe(false);
    expect(boxPointValid(0, 36.8)).toBe(false);
  });
});

describe('Beem client', () => {
  it('normalises Tanzanian numbers', () => {
    expect(normalizeRecipient('0712 345 678')).toBe('255712345678');
    expect(normalizeRecipient('+255712345678')).toBe('255712345678');
    expect(normalizeRecipient('712345678')).toBe('255712345678');
  });
  it('accepts BEEM_API_SECRET as an alias and reports config honestly', () => {
    expect(beemConfigured({})).toBe(false);
    expect(beemConfigured({ BEEM_API_KEY: 'a' })).toBe(false);
    expect(beemConfigured({ BEEM_API_KEY: 'a', BEEM_API_SECRET: 'b' })).toBe(true);
  });
  it('missing credentials is a dry run with no network call', async () => {
    const f = vi.fn();
    expect(await sendSMS({ to: '0712345678', message: 'x' }, { env: {}, fetchImpl: f as any })).toMatchObject({ success: false, dryRun: true });
    expect(f).not.toHaveBeenCalled();
  });
  it('succeeds on code 100 or a "submitted" message', async () => {
    const env = { BEEM_API_KEY: 'a', BEEM_SECRET_KEY: 'b', BEEM_SENDER_ID: 'S' };
    for (const body of [{ code: 100 }, { successful: true, request_id: 1 }, { data: { message: 'Message submitted successfully' } }]) {
      const f = vi.fn(async () => new Response(JSON.stringify(body)));
      expect((await sendSMS({ to: '0712345678', message: 'x' }, { env, fetchImpl: f as any })).success).toBe(true);
    }
  });
  it('gives up after 3 attempts with backoff 1 s then 2 s', async () => {
    const env = { BEEM_API_KEY: 'a', BEEM_SECRET_KEY: 'b', BEEM_SENDER_ID: 'S' };
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 999, message: 'temporary' })));
    const waits: number[] = [];
    const r = await sendSMSWithRetry({ to: '0712345678', message: 'x' }, { env, fetchImpl: f as any, sleep: async (ms) => void waits.push(ms) });
    expect(r.success).toBe(false);
    expect(f).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1000, 2000]);
  });
  it('balance check hits the vendors/balance endpoint with Basic auth', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: { credit_balance: 120 } })));
    const r = await checkBalance({ env: { BEEM_API_KEY: 'a', BEEM_SECRET_KEY: 'b' }, fetchImpl: f as any });
    expect(r).toMatchObject({ success: true, balance: 120, reachable: true, httpStatus: 200 });
    expect((f.mock.calls[0] as any)[0]).toBe('https://apisms.beem.africa/public/v1/vendors/balance');
  });
});

describe('Tanzanian phone validation', () => {
  it.each([['0712345678', '255712345678'], ['0612 345 678', '255612345678'], ['+255712345678', '255712345678'], ['255 712 345 678', '255712345678'], ['0712-345-678', '255712345678']])('%s is valid', (i, o) => expect(normalizeTzPhone(i)).toBe(o));
  it.each(['', '123', '0512345678', '071234567', '07123456789', '+254712345678', 'abc', '+25571234567x', '00712345678'])('%j is invalid', (i) => expect(normalizeTzPhone(i)).toBeNull());
  it('masks all but the last 3 digits', () => expect(maskPhone('255712345678')).toBe('+255 7•• ••• 678'));
});

describe('Beem retry rules (documented response codes)', () => {
  // docs.beem.africa/guides/sms/api-responses: 100 success, 103 the one retryable server error,
  // everything else in 101-123 is a permanent failure.
  it.each([101, 102, 104, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123])(
    'code %i is permanent', (c) => expect(isPermanentFailure(c)).toBe(true),
  );
  it('code 103 is the one Beem code worth retrying', () => expect(isPermanentFailure(103)).toBe(false));
  it('an unknown code and no code at all stay retryable', () => {
    expect(isPermanentFailure(999)).toBe(false);
    expect(isPermanentFailure(undefined)).toBe(false);
  });
  it('HTTP 4xx is permanent except 408 and 429', () => {
    expect(isPermanentFailure(400)).toBe(true);
    expect(isPermanentFailure(401)).toBe(true);
    expect(isPermanentFailure(408)).toBe(false);
    expect(isPermanentFailure(429)).toBe(false);
    expect(isPermanentFailure(503)).toBe(false);
  });
  it('stops after one attempt on a documented permanent code', async () => {
    const env = { BEEM_API_KEY: 'a', BEEM_SECRET_KEY: 'b', BEEM_SENDER_ID: 'S' };
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 109, message: 'bad message' })));
    const r = await sendSMSWithRetry({ to: '0712345678', message: 'x' }, { env, fetchImpl: f as any, sleep: async () => {} });
    expect(f).toHaveBeenCalledTimes(1);
    // The log gets the documented code name, never Beem's free text.
    expect(r).toMatchObject({ success: false, code: 109, error: 'invalid_message' });
  });
  it('retries code 103 the full three times', async () => {
    const env = { BEEM_API_KEY: 'a', BEEM_SECRET_KEY: 'b', BEEM_SENDER_ID: 'S' };
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 103 })));
    await sendSMSWithRetry({ to: '0712345678', message: 'x' }, { env, fetchImpl: f as any, sleep: async () => {} });
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe('sender ID checks (Beem: alphanumeric, max 11 characters)', () => {
  it.each([undefined, '', '   '])('%j is missing', (v) => expect(senderIdIssue(v)).toBe('missing'));
  it('rejects more than 11 characters', () => expect(senderIdIssue('TWELVECHARSX')).toBe('too_long'));
  it('rejects punctuation', () => expect(senderIdIssue('MY-SENDER')).toBe('not_alphanumeric'));
  it.each(['KIPIMO', 'Sender 1', 'ELEVENCHARS'])('%s is usable', (v) => expect(senderIdIssue(v)).toBeNull());
});

describe('delivery-report callback parsing (UNVERIFIED: no real callback seen)', () => {
  it('reads the documented uppercase form fields', () => {
    expect(parseDlrCallback({ DLRID: '77', STATUS: '1', DESTADDR: '255712345678' })).toEqual({
      dlrId: '77', report: { state: 'delivered', raw: '1 Delivered' },
    });
    expect(parseDlrCallback({ DLRID: '77', STATUS: '3' })!.report.state).toBe('failed');
  });
  it('maps every documented status code to a state without inventing one', () => {
    for (const [code, spec] of Object.entries(DLR_STATUS)) {
      const r = parseDlrCallback({ DLRID: 'x', STATUS: code })!;
      expect(r.report.state).toBe(spec.state);
      expect(r.report.raw).toBe(`${code} ${spec.word}`);
    }
  });
  it('does not call "Orphaned" or "Unknown" a failure', () => {
    expect(parseDlrCallback({ DLRID: 'x', STATUS: 9 })!.report.state).toBe('unknown');
    expect(parseDlrCallback({ DLRID: 'x', STATUS: 11 })!.report.state).toBe('unknown');
  });
  it('accepts lowercase keys and the polling API words too', () => {
    expect(parseDlrCallback({ request_id: 'r1', status: 'DELIVERED' })).toEqual({ dlrId: 'r1', report: { state: 'delivered', raw: 'DELIVERED' } });
    expect(parseDlrCallback({ dlr_id: 'r2', status: 'undelivered' })!.report.state).toBe('failed');
  });
  it('an unrecognised status is unknown, never delivered or failed', () => {
    expect(parseDlrCallback({ DLRID: 'x', STATUS: 'WAT' })!.report).toEqual({ state: 'unknown', raw: 'WAT' });
  });
  it('a body with no STATUS is not a delivery report', () => {
    expect(parseDlrCallback({ SOURCEADDR: '255712345678', MESSAGE: 'RIPOTI K3 OKS 5.2' })).toBeNull();
    expect(parseDlrCallback(null)).toBeNull();
    expect(parseDlrCallback('STATUS=1')).toBeNull();
  });
});

describe('delivery-report polling API', () => {
  const env = { BEEM_API_KEY: 'a', BEEM_SECRET_KEY: 'b' };
  it('calls the documented URL with dest_addr and request_id, and maps the three words', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ dest_addr: '255712345678', status: 'DELIVERED', request_id: '77' }])));
    const r = await getDeliveryReport({ destAddr: '0712345678', requestId: '77' }, { env, fetchImpl: f as any });
    expect(r).toMatchObject({ success: true, report: { state: 'delivered', raw: 'DELIVERED' } });
    const url = (f.mock.calls[0] as any)[0] as string;
    expect(url.startsWith(BEEM_DLR_URL)).toBe(true);
    expect(url).toContain('dest_addr=255712345678');
    expect(url).toContain('request_id=77');
  });
  it.each([['PENDING', 'pending'], ['UNDELIVERED', 'failed']])('%s maps to %s', async (word, state) => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ status: word }])));
    expect((await getDeliveryReport({ destAddr: '0712345678', requestId: '1' }, { env, fetchImpl: f as any })).report!.state).toBe(state);
  });
  it('an undocumented word is unknown, not a guess', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ status: 'SOMETHING_NEW' }])));
    expect((await getDeliveryReport({ destAddr: '0712345678', requestId: '1' }, { env, fetchImpl: f as any })).report!.state).toBe('unknown');
  });
  it('404 is reported as no report, not as a failure to deliver', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 404 }));
    expect(await getDeliveryReport({ destAddr: '0712345678', requestId: '1' }, { env, fetchImpl: f as any })).toMatchObject({ success: false, error: 'report_not_found' });
  });
  it('without credentials nothing is called', async () => {
    const f = vi.fn();
    expect(await getDeliveryReport({ destAddr: '0712345678', requestId: '1' }, { env: {}, fetchImpl: f as any })).toMatchObject({ success: false, error: 'not_configured' });
    expect(f).not.toHaveBeenCalled();
  });
});
