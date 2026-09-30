import { describe, expect, it } from 'vitest';
import { ALL_TEMPLATE_IDS, isGsm7, renderSms, SMS_MAX, smsLength, templateForAlert } from '../src/core/sms-templates';
import { parseInboundSms } from '../src/core/sms-parser';

describe('SMS templates', () => {
  const worstCase = { cage: 99, value: 99.9, delta: 12.5, hours: 999, low: true, summary: 'OKS 20.0, JOTO 40.0, PH 11.0, CHAKULA 5000, FA 100000' };
  for (const lang of ['sw', 'en'] as const) {
    for (const id of ALL_TEMPLATE_IDS) {
      it(`${lang}/${id} is <= ${SMS_MAX} characters and GSM-7`, () => {
        for (const p of [worstCase, { ...worstCase, low: false }, { cage: 3, value: 3.8, delta: 3.4, hours: 30, summary: 'OKS 5.2' }]) {
          const s = renderSms(id, lang, p);
          expect(smsLength(s), s).toBeLessThanOrEqual(SMS_MAX);
          expect(isGsm7(s), s).toBe(true);
          expect(s).not.toMatch(/undefined|NaN/);
        }
      });
    }
  }
  it('matches the spec example wording for a low oxygen alert', () => {
    expect(renderSms('do_critical', 'sw', { cage: 3, value: 3.8 })).toBe('Tahadhari Kizimba 3: oksijeni 3.8 mg/L (chini). Acha kulisha. Angalia tena baada ya saa 1.');
  });
  it('detects non-GSM characters', () => {
    expect(isGsm7('27.5 °C')).toBe(false);
    expect(isGsm7('café ok')).toBe(true);
    expect(isGsm7('smile 🙂')).toBe(false);
  });
  it('maps every alert rule to a template', () => {
    for (const rule of ['do', 'temp', 'ph', 'turnover', 'wind', 'rain', 'stale'] as const)
      for (const severity of ['watch', 'critical'] as const) expect(ALL_TEMPLATE_IDS).toContain(templateForAlert({ rule, severity }));
  });
});

describe('inbound SMS parser', () => {
  it('parses the Swahili example', () => {
    expect(parseInboundSms('RIPOTI K3 OKS 5.2 JOTO 27.5 PH 7.4')).toMatchObject({ ok: true, lang: 'sw', cageNumber: 3, values: { do: 5.2, temp: 27.5, ph: 7.4 } });
  });
  it('parses the English example', () => {
    expect(parseInboundSms('REPORT C3 DO 5.2 T 27.5 PH 7.4')).toMatchObject({ ok: true, lang: 'en', cageNumber: 3, values: { do: 5.2, temp: 27.5, ph: 7.4 } });
  });
  it('is forgiving about case, spacing and decimal commas', () => {
    expect(parseInboundSms('  ripoti k12   oks 5,2 ')).toMatchObject({ ok: true, cageNumber: 12, values: { do: 5.2 } });
    expect(parseInboundSms('report cage 4 feed 12.5 dead 3')).toMatchObject({ ok: true, cageNumber: 4, values: { feed: 12.5, dead: 3 } });
  });
  it.each([
    ['', 'empty'], ['   ', 'empty'], ['HELLO K3 OKS 5', 'unknown_command'], ['RIPOTI', 'no_cage'], ['RIPOTI X3 OKS 5', 'bad_cage'], ['RIPOTI K OKS 5', 'bad_cage'],
    ['RIPOTI K0 OKS 5', 'bad_cage'], ['RIPOTI K3', 'no_values'], ['RIPOTI K3 OKS', 'missing_value'], ['RIPOTI K3 OKS abc', 'bad_number'], ['RIPOTI K3 OKS 5 OKS 6', 'duplicate_field'],
    ['RIPOTI K3 XYZ 5', 'unknown_field'], ['RIPOTI K3 OKS 25', 'out_of_range'], ['RIPOTI K3 JOTO 5', 'out_of_range'], ['RIPOTI K3 PH 12', 'out_of_range'], ['RIPOTI K3 FA 2.5', 'out_of_range'],
    ['RIPOTI K3 OKS -1', 'bad_number'],
  ])('rejects %j as %s', (text, error) => {
    expect(parseInboundSms(text as string)).toMatchObject({ ok: false, error });
  });
  it('builds a short confirmation summary', () => {
    const p = parseInboundSms('RIPOTI K3 OKS 5.2 JOTO 27.5 PH 7.4');
    expect(p.ok && p.summary).toBe('OKS 5.2, JOTO 27.5, PH 7.4');
  });
});
