import { Minus, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  const t = useT();
  return (
    <button type="button" role="switch" aria-checked={checked} className="bw-switch" onClick={() => onChange(!checked)}>
      <span className="bw-switch__label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      <span className="bw-switch__word">{checked ? t('common.on') : t('common.off')}</span>
      <span className="bw-switch__track" aria-hidden="true">
        <span className="bw-switch__thumb" />
      </span>
    </button>
  );
}

export function Segmented<V extends string>({ value, options, onChange, label }: { value: V; options: { value: V; label: ReactNode }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div className="bw-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="bw-seg__opt" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface StepperProps {
  label: string;
  unit: string;
  value: string; // raw text, '' means not entered
  onChange: (v: string) => void;
  step: number;
  min: number;
  max: number;
  start: number;
  decimals: number;
  error?: string | null;
  hint?: string;
}
/** Big +/- buttons around a value you can also type. Empty means "not entered" and shows a dash, never 0. */
export function Stepper(p: StepperProps) {
  const t = useT();
  const id = useId();
  const n = p.value.trim() === '' ? null : Number(p.value.replace(',', '.'));
  const bump = (dir: 1 | -1) => {
    const base = n === null || Number.isNaN(n) ? p.start : n + dir * p.step;
    const next = Math.min(p.max, Math.max(p.min, Math.round(base * 100) / 100));
    p.onChange(next.toFixed(p.decimals));
  };
  return (
    <div className="field">
      <label className="bw-field-label" htmlFor={id}>
        {p.label}
      </label>
      <div className="bw-stepper">
        <button type="button" className="bw-stepper__btn" aria-label={`${p.label}: ${t('common.less')}`} onClick={() => bump(-1)} disabled={n !== null && !Number.isNaN(n) && n <= p.min}>
          <Minus className="bw-icon" />
        </button>
        <div>
          <input
            id={id}
            className="stepper-input"
            inputMode="decimal"
            autoComplete="off"
            value={p.value}
            placeholder={'—'}
            aria-invalid={!!p.error}
            aria-describedby={p.error ? `${id}-err` : undefined}
            onChange={(e) => p.onChange(e.target.value.replace(/[^0-9.,]/g, ''))}
          />
          <span className="bw-stepper__unit">{p.unit}</span>
        </div>
        <button type="button" className="bw-stepper__btn" aria-label={`${p.label}: ${t('common.more')}`} onClick={() => bump(1)} disabled={n !== null && !Number.isNaN(n) && n >= p.max}>
          <Plus className="bw-icon" />
        </button>
      </div>
      {p.hint && !p.error && <div className="hint">{p.hint}</div>}
      {p.error && (
        <div id={`${id}-err`} className="field-error" role="alert">
          {p.error}
        </div>
      )}
    </div>
  );
}

/** Bottom sheet. The only element in the design that carries a shadow. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-root">
      <div className="sheet-scrim" onClick={onClose} />
      <div className="bw-sheet sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="bw-sheet__handle" />
        <div className="sheet-head">
          <h2 className="bw-sheet__title">{title}</h2>
          <button type="button" className="bw-iconbtn" onClick={onClose} aria-label={t('common.close')}>
            <X className="bw-icon" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Collapse({ title, children, defaultOpen = false, right }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="collapse">
      <button type="button" className="collapse-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="collapse-title">{title}</span>
        {right}
        <span className="collapse-chev" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div id={id} className="collapse-body">{children}</div>}
    </div>
  );
}
