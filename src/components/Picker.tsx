import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Wheel } from './Wheel';

export interface Option<T> { value: T; label: string }

/** Scroll-wheel chooser (used whenever there are more than two options). */
export function WheelPicker<T>({ options, value, onChange, ariaLabel, height }: {
  options: Option<T>[]; value: T; onChange: (v: T) => void; ariaLabel: string; height?: number;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const values = options.map((_, i) => i);
  return <Wheel values={values} index={idx} onIndex={(i) => onChange(options[i].value)} format={(i) => options[i]?.label ?? ''} ariaLabel={ariaLabel} height={height} />;
}

/** A list row that shows the current choice and opens a wheel sheet. */
export function PickerRow<T>({ label, sub, options, value, onChange, title, icon }: {
  label: string; sub?: string; options: Option<T>[]; value: T; onChange: (v: T) => void; title?: string; icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const cur = options.find((o) => o.value === value);
  return (
    <>
      <button className="list-item pressable" onClick={() => { setDraft(value); setOpen(true); }} aria-haspopup="dialog">
        {icon}
        <span className="grow"><span className="title">{label}</span>{sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}</span>
        <span className="picker-value num">{cur?.label ?? '–'}</span>
        <Icon name="chevronRight" className="chev" size={18} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title ?? label}>
        <div className="stack" style={{ gap: 14 }}>
          <WheelPicker options={options} value={draft} onChange={setDraft} ariaLabel={label} />
          <button className="btn primary lg block" onClick={() => { onChange(draft); setOpen(false); }}><Icon name="check" size={20} stroke={2.6} /> Done</button>
        </div>
      </Sheet>
    </>
  );
}

export const range = (from: number, to: number, step = 1) => {
  const out: number[] = [];
  for (let v = from; step > 0 ? v <= to + 1e-9 : v >= to - 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};
