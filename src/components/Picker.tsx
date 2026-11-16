import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

export interface Option<T> { value: T; label: string; sub?: string }

/** Tap list for non-numeric choices: big rows, the current one marked and scrolled into view.
 *  No scroll handling at all (numbers use NumberPicker). */
export function OptionList<T>({ options, value, onPick, ariaLabel }: {
  options: Option<T>[]; value: T; onPick: (v: T) => void; ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.querySelector<HTMLElement>('.opt-row.on');
    if (el && row && el.scrollHeight > el.clientHeight) el.scrollTop = row.offsetTop - (el.clientHeight - row.offsetHeight) / 2;
  }, []);
  return (
    <div ref={ref} className="opt-list" role="group" aria-label={ariaLabel} style={{ position: 'relative' }}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button key={i} type="button" className={'opt-row' + (on ? ' on' : '')} aria-pressed={on} onClick={() => onPick(o.value)}>
            <span>{o.label}{o.sub && <span className="opt-sub">{o.sub}</span>}</span>
            {on && <Icon name="check" size={20} stroke={2.6} className="opt-check" />}
          </button>
        );
      })}
    </div>
  );
}

/** Sheet with an OptionList: tap = set + close. */
export function OptionSheet<T>({ open, onClose, title, options, value, onPick }: {
  open: boolean; onClose: () => void; title: string; options: Option<T>[]; value: T; onPick: (v: T) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <OptionList options={options} value={value} ariaLabel={title} onPick={(v) => { onPick(v); onClose(); }} />
    </Sheet>
  );
}

/** A list row that shows the current choice and opens a tap list. */
export function PickerRow<T>({ label, sub, options, value, onChange, title, icon }: {
  label: string; sub?: string; options: Option<T>[]; value: T; onChange: (v: T) => void; title?: string; icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  return (
    <>
      <button type="button" className="list-item pressable" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {icon}
        <span className="grow"><span className="title">{label}</span>{sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}</span>
        <span className="picker-value num">{cur?.label ?? '–'}</span>
        <Icon name="chevronRight" className="chev" size={18} />
      </button>
      <OptionSheet open={open} onClose={() => setOpen(false)} title={title ?? label} options={options} value={value} onPick={onChange} />
    </>
  );
}

export const range = (from: number, to: number, step = 1) => {
  const out: number[] = [];
  for (let v = from; step > 0 ? v <= to + 1e-9 : v >= to - 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};
