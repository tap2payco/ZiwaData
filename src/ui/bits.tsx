import { CircleCheck, CircleDashed, Hand, OctagonX, Radio, Satellite, TriangleAlert, ShieldCheck, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Reading, Source, Status } from '../core/types';
import { useT } from '../i18n';
import { ageParts, formatDate, formatDateTime, formatTime, DAY_MS } from '../core/format';
import { useLang } from '../i18n';
import { DEMO_BUILD } from '../core/config';

const STATUS_ICON = { ok: CircleCheck, watch: TriangleAlert, critical: OctagonX, none: CircleDashed } as const;
export function StatusIcon({ status, size = 16 }: { status: Status; size?: number }) {
  const I = STATUS_ICON[status];
  return <I className="bw-icon" width={size} height={size} aria-hidden="true" />;
}
/** Icon + word + colour. Never colour alone. */
export function StatusBadge({ status }: { status: Status }) {
  const t = useT();
  const word = { ok: t('status.ok'), watch: t('status.watch'), critical: t('status.critical'), none: t('status.none') }[status];
  return (
    <span className={`bw-badge bw-badge--${status}`}>
      <StatusIcon status={status} />
      {word}
    </span>
  );
}
const SRC_ICON = { manual: Hand, sensor: Radio, satellite: Satellite } as const;
export function SourceTag({ source, via, attested }: { source: Source; via?: Reading['via']; attested?: boolean }) {
  const t = useT();
  const I = SRC_ICON[source];
  const word = { manual: t('src.manual'), sensor: t('src.sensor'), satellite: t('src.satellite') }[source];
  return (
    <span className="src-group">
      <span className={`bw-src bw-src--${source}`}>
        <I className="bw-icon" aria-hidden="true" />
        {word}
      </span>
      {via === 'sms' && <span className="note-small">{t('src.viaSms')}</span>}
      {attested && (
        <span className="bw-src bw-src--attested">
          <ShieldCheck className="bw-icon" aria-hidden="true" />
          {t('src.attested')}
        </span>
      )}
    </span>
  );
}
export function DemoChip() {
  const t = useT();
  if (!DEMO_BUILD) return null;
  return <span className="bw-src bw-src--demo">{t('demo.chip')}</span>;
}
export function Chevron() {
  return <ChevronRight className="bw-icon bw-row__chev" aria-hidden="true" />;
}
export function Icon({ as: I, size, label }: { as: React.ComponentType<any>; size?: 'sm' | 'lg'; label?: string }) {
  return <I className={`bw-icon${size ? ` bw-icon--${size}` : ''}`} aria-hidden={label ? undefined : true} aria-label={label} />;
}

/** Date/time/age helpers bound to the current language. */
export function useFmt(now: number) {
  const lang = useLang();
  const t = useT();
  return {
    date: (ms: number) => formatDate(ms, lang),
    time: formatTime,
    dateTime: (ms: number) => formatDateTime(ms, lang),
    age: (ts: string | number) => {
      const p = ageParts(typeof ts === 'string' ? Date.parse(ts) : ts, now);
      return p.unit === 'min' ? t('age.min', { n: p.n }) : p.unit === 'h' ? t('age.h', { n: p.n }) : t('age.d', { n: p.n });
    },
    day: (ms: number) => formatDate(ms, lang),
    DAY_MS,
  };
}
export const Row = ({ children }: { children: ReactNode }) => <div className="row-wrap">{children}</div>;
