import { describe, expect, it } from 'vitest';
import { canResumeFeeding, classifyDo, classifyPh, classifyTemp, classifyWeather, evaluateTurnover, feedingLevel, isPlausible, isStale, worst } from '../src/core/rules';

describe('dissolved oxygen', () => {
  it.each([[5.0, 'ok'], [7.2, 'ok'], [4.99, 'watch'], [4.0, 'watch'], [3.99, 'critical'], [0, 'critical']])('%s mg/L is %s', (v, s) => expect(classifyDo(v)).toBe(s));
  it('unknown is none, never ok and never 0', () => {
    expect(classifyDo(null)).toBe('none');
    expect(classifyDo(undefined)).toBe('none');
    expect(classifyDo(NaN)).toBe('none');
  });
});
describe('temperature', () => {
  it.each([[24, 'ok'], [31, 'ok'], [27.5, 'ok'], [23.9, 'watch'], [20, 'watch'], [31.1, 'watch'], [34, 'watch'], [19.9, 'critical'], [34.1, 'critical']])('%s C is %s', (v, s) => expect(classifyTemp(v)).toBe(s));
  it('unknown is none', () => expect(classifyTemp(undefined)).toBe('none'));
});
describe('pH', () => {
  it.each([[6.5, 'ok'], [9.0, 'ok'], [6.4, 'watch'], [6.0, 'watch'], [9.1, 'watch'], [9.5, 'watch'], [5.9, 'critical'], [9.6, 'critical']])('pH %s is %s', (v, s) => expect(classifyPh(v)).toBe(s));
});
describe('turnover risk', () => {
  it('needs a deep probe', () => expect(evaluateTurnover({ surface: 28, deep: undefined, doSeries: [6, 5, 4] })).toMatchObject({ status: 'none', reason: 'no_probe' }));
  it('difference below 3 C is clear even if DO falls', () => expect(evaluateTurnover({ surface: 28, deep: 25.5, doSeries: [6, 5, 4.5] }).status).toBe('ok'));
  it('>= 3 C and DO dropping >= 1.0 over 3 readings is Watch', () => {
    expect(evaluateTurnover({ surface: 28, deep: 25, doSeries: [6.0, 5.5, 4.9] })).toMatchObject({ status: 'watch', deltaC: 3, doDrop: 1.1 });
  });
  it('>= 3 C and DO steady is clear', () => expect(evaluateTurnover({ surface: 28, deep: 24, doSeries: [6.0, 5.9, 6.1] }).status).toBe('ok'));
  it('>= 3 C and DO < 4.0 is Critical', () => expect(evaluateTurnover({ surface: 28, deep: 24, doSeries: [4.2, 4.1, 3.9] }).status).toBe('critical'));
  it('uses only the last 3 DO readings', () => expect(evaluateTurnover({ surface: 28, deep: 24, doSeries: [9, 6.0, 6.0, 6.0] }).status).toBe('ok'));
});
describe('weather', () => {
  it('wind 30 Watch, 45 Critical; rain 20 mm Watch', () => {
    expect(classifyWeather({ windKmh: 29.9, rainMm: 19.9 })).toMatchObject({ wind: 'ok', rain: 'ok', overall: 'ok' });
    expect(classifyWeather({ windKmh: 30, rainMm: 0 }).wind).toBe('watch');
    expect(classifyWeather({ windKmh: 45, rainMm: 0 }).wind).toBe('critical');
    expect(classifyWeather({ windKmh: 0, rainMm: 20 }).rain).toBe('watch');
    expect(classifyWeather({ windKmh: 10, rainMm: 60 }).overall).toBe('watch');
  });
  it('missing forecast values are none, not ok', () => expect(classifyWeather({ windKmh: null, rainMm: undefined })).toMatchObject({ wind: 'none', rain: 'none', overall: 'none' }));
});
describe('stale and feeding', () => {
  it('stale after more than 24 h', () => {
    const now = Date.UTC(2026, 8, 29, 12);
    expect(isStale(now - 24 * 3600_000, now)).toBe(false);
    expect(isStale(now - 24 * 3600_000 - 1, now)).toBe(true);
    expect(isStale(null, now)).toBe(false);
  });
  it('feeding guidance follows the rules', () => {
    expect(feedingLevel({ doStatus: 'ok', turnoverStatus: 'ok' })).toBe('normal');
    expect(feedingLevel({ doStatus: 'watch', turnoverStatus: 'ok' })).toBe('half');
    expect(feedingLevel({ doStatus: 'critical', turnoverStatus: 'ok' })).toBe('pause');
    expect(feedingLevel({ doStatus: 'ok', turnoverStatus: 'watch' })).toBe('pause');
    expect(feedingLevel({ doStatus: 'watch', turnoverStatus: 'ok', weatherStatus: 'critical' })).toBe('secure_pause');
  });
  it('resume only when DO is above 5.5 on two readings', () => {
    expect(canResumeFeeding([4, 5.6])).toBe(false);
    expect(canResumeFeeding([5.6, 5.5])).toBe(false);
    expect(canResumeFeeding([4, 5.6, 5.7])).toBe(true);
  });
});
describe('helpers', () => {
  it('worst', () => {
    expect(worst('ok', 'watch')).toBe('watch');
    expect(worst('none', 'ok')).toBe('ok');
    expect(worst('none')).toBe('none');
    expect(worst('watch', 'critical', 'ok')).toBe('critical');
  });
  it('plausible ranges', () => {
    expect(isPlausible('do', 20)).toBe(true);
    expect(isPlausible('do', 20.1)).toBe(false);
    expect(isPlausible('temp', 9.9)).toBe(false);
    expect(isPlausible('ph', 11)).toBe(true);
    expect(isPlausible('ph', 3.9)).toBe(false);
  });
});
