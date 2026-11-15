import { useEffect, useLayoutEffect, useRef } from 'react';

// Native-momentum scroll wheel: CSS scroll-snap gives iOS's own deceleration physics for free,
// we just read which row sits in the centre band.
const ROW = 52;

export function Wheel({ values, index, onIndex, format, height = 5 * ROW, ariaLabel }: {
  values: number[]; index: number; onIndex: (i: number) => void; format: (v: number) => string; height?: number; ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const settling = useRef<number | undefined>(undefined);
  const lastEmitted = useRef(index);
  const pad = (height - ROW) / 2;

  // Jump to the external index when it changes from outside (unit/step switch, open).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || index === lastEmitted.current && Math.round(el.scrollTop / ROW) === index) return;
    el.scrollTop = index * ROW;
    lastEmitted.current = index;
  }, [index, values]);

  useEffect(() => () => clearTimeout(settling.current), []);

  const onScroll = () => {
    const el = ref.current!;
    const i = Math.max(0, Math.min(values.length - 1, Math.round(el.scrollTop / ROW)));
    if (i !== lastEmitted.current) { lastEmitted.current = i; onIndex(i); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(values.length - 1, index + d));
    ref.current?.scrollTo({ top: i * ROW, behavior: 'smooth' });
  };

  return (
    <div style={{ position: 'relative', height }}>
      <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, top: pad, height: ROW, borderRadius: 14, background: 'var(--card-2)' }} />
      <div ref={ref} onScroll={onScroll} tabIndex={0} role="slider" aria-label={ariaLabel} onKeyDown={onKey}
        aria-valuenow={values[index]} aria-valuetext={format(values[index] ?? 0)}
        style={{
          position: 'relative', height, overflowY: 'scroll', scrollSnapType: 'y mandatory', scrollbarWidth: 'none',
          paddingTop: pad, paddingBottom: pad, touchAction: 'pan-y', overscrollBehavior: 'contain',
          maskImage: 'linear-gradient(transparent, #000 30%, #000 70%, transparent)',
          WebkitMaskImage: 'linear-gradient(transparent, #000 30%, #000 70%, transparent)',
        }}>
        {values.map((v, i) => (
          <div key={i} onClick={() => ref.current?.scrollTo({ top: i * ROW, behavior: 'smooth' })}
            className="num"
            style={{
              height: ROW, display: 'grid', placeItems: 'center', scrollSnapAlign: 'center',
              fontSize: i === index ? '2rem' : '1.5rem', fontWeight: i === index ? 750 : 500, letterSpacing: '-0.02em',
              color: i === index ? 'var(--text)' : 'var(--text-3)', transition: 'font-size 120ms, color 120ms',
            }}>
            {format(v)}
          </div>
        ))}
      </div>
    </div>
  );
}
