// Cards the agent puts in the chat: food requests (editable: swap / amount / uncheck, then Log (N)), other change
// requests (friendly rows), and multiple-choice questions (ask_user).
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { NumberSheet, type NumberSpec } from './NumberPicker';
import { getItem, type FoodItem } from '../db/food';
import { describeAction, type Described } from '../lib/agent/describe';
import { foodEmoji, foodLines, isFoodAction, setAmount, swapFood, toggleLine, type FoodLine } from '../lib/agent/food';
import { resolvePending, updatePendingActions } from '../lib/agent/loop';
import type { AskQuestion, Chat, PendingRequest, RequestAction } from '../lib/agent/types';
import { unitLabel } from '../lib/units';

type Outcome = NonNullable<Chat['cards']>[string]['outcome'];
const OUTCOME: Record<string, { icon: string; text: string; cls: string }> = {
  applied: { icon: 'check', text: 'Done', cls: 'good' }, rejected: { icon: 'close', text: 'Skipped', cls: 'muted' },
  comment: { icon: 'chat', text: 'Changing', cls: 'muted' }, failed: { icon: 'info', text: 'Failed', cls: 'bad' }, answered: { icon: 'check', text: 'Answered', cls: 'good' },
};
const spring = { type: 'spring', bounce: 0, duration: 0.35 } as const;
const appear = { initial: { opacity: 0, y: 10, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: spring };

/** Loads FoodItems for keys (own foods and the bundled databases). */
function useFoods(keys: string[]) {
  const [map, setMap] = useState<Map<string, FoodItem>>(new Map());
  const k = [...new Set(keys)].sort().join('|');
  useEffect(() => {
    let live = true;
    Promise.all(k.split('|').filter(Boolean).map(async (key) => [key, await getItem(key)] as const))
      .then((rows) => live && setMap(new Map(rows.filter((r): r is [string, FoodItem] => !!r[1]))));
    return () => { live = false; };
  }, [k]);
  return map;
}

const r0 = (v: number) => Math.round(v);
const fmtQ = (v: number) => (Math.round(v * 100) / 100).toString();
const english = (it?: FoodItem) => !!it?.alt && /\p{Script=Hebrew}/u.test(it.name);
/** Display name: English when the item has one (keeps rows short and LTR); Hebrew otherwise, rendered dir=auto. */
const shown = (it?: FoodItem) => (it ? (english(it) ? it.alt! : it.name) : '…');
function amountText(line: FoodLine, it?: FoodItem) {
  const base = it?.unitBase ?? 'g';
  const u = line.item.unit;
  if (u === base || u === 'g' || u === 'ml') return `${fmtQ(line.item.grams)} ${base}`;
  const label = unitLabel(u, true).replace(/^1 /, '');
  return `${fmtQ(line.item.qty)} ${label}`;
}
const BASE_Q: NumberSpec = { min: 5, max: 1000, step: 5, decimals: 1, keyMin: 0.1, keyMax: 5000 };
const PORTION_Q: NumberSpec = { min: 0.25, max: 10, step: 0.25, decimals: 2, keyMin: 0.01, keyMax: 100 };

/** Food log request in the style of a food-log screen: total, one row per food, alternatives, Log (N). */
export function FoodCard({ chatId, p, outcome, onChange }: { chatId: string; p: PendingRequest; outcome?: Outcome; onChange?: () => void }) {
  const active = !outcome;
  const busy = p.status === 'applying';
  const groups = p.actions.map((a, ai) => ({ a, ai, lines: isFoodAction(a.name) ? foodLines(a) : [] }));
  const keys = groups.flatMap((g) => g.lines.flatMap((l) => [l.item.foodKey, ...l.alts]));
  const foods = useFoods(keys);
  const [picking, setPicking] = useState<{ ai: number; li: number } | null>(null);
  const edit = async (ai: number, next: RequestAction) => { const actions = [...p.actions]; actions[ai] = next; await updatePendingActions(chatId, actions); };
  const rows = groups.flatMap((g) => g.lines.map((l, li) => ({ ...g, l, li })));
  const on = rows.filter((r) => !r.l.off);
  const shownRows = active ? rows : on;
  const tot = on.reduce((t, r) => { const it = foods.get(r.l.item.foodKey); const f = (r.l.item.grams || 0) / 100;
    return it ? { kcal: t.kcal + it.per100.kcal * f, p: t.p + it.per100.p * f } : t; }, { kcal: 0, p: 0 });
  const o = outcome ? OUTCOME[outcome] : null;
  const pick = picking ? rows.find((r) => r.ai === picking.ai && r.li === picking.li) : undefined;
  const pickFood = pick ? foods.get(pick.l.item.foodKey) : undefined;
  const portion = pick && pickFood && !['g', 'ml', pickFood.unitBase].includes(pick.l.item.unit);
  return (
    <motion.section className={'fcard' + (active ? '' : ' done')} {...appear} aria-label={`Food to log: ${p.summary}`} data-role="food">
      <div className="fcard-head">
        <div className="grow">
          <div className="fcard-label">Total Calories</div>
          <div className="fcard-total"><span className="num">{r0(tot.kcal).toLocaleString()}</span> cals<span className="fcard-sep"> / </span><span className="num">{r0(tot.p)}g</span> Protein</div>
        </div>
        {o && <span className={'req-outcome ' + o.cls}><Icon name={o.icon} size={14} stroke={2.6} />{o.text}</span>}
      </div>
      <div className="fcard-rows">
        {shownRows.map(({ a, ai, l, li }) => {
          const it = foods.get(l.item.foodKey);
          const f = (l.item.grams || 0) / 100;
          return (
            <div key={`${ai}-${li}`} className={'frow-wrap' + (l.off ? ' off' : '')}>
              <div className="frow">
                <span className="frow-emoji" aria-hidden>{foodEmoji(`${it?.name ?? ''} ${it?.alt ?? ''}`)}</span>
                <span className="grow frow-main">
                  <span className="frow-name" dir="auto">{shown(it)}</span>
                  {it && <span className="frow-macros num"><b className="mc-c">{r0(it.per100.c * f)}C</b> <b className="mc-p">{r0(it.per100.p * f)}P</b> <b className="mc-f">{r0(it.per100.f * f)}F</b></span>}
                </span>
                <span className="frow-right">
                  <span className="frow-kcal num">{it ? r0(it.per100.kcal * f) : '–'} cals</span>
                  {active ? <button className="frow-amt num" disabled={busy} onClick={() => setPicking({ ai, li })} aria-label={`Amount of ${shown(it)}: ${amountText(l, it)}`}>{amountText(l, it)}</button>
                    : <span className="frow-amt num">{amountText(l, it)}</span>}
                </span>
                {active && (
                  <button className={'frow-check' + (l.off ? '' : ' on')} disabled={busy} aria-pressed={!l.off} aria-label={`${l.off ? 'Include' : 'Exclude'} ${shown(it)}`}
                    onClick={() => edit(ai, toggleLine(a, li))}><Icon name="check" size={16} stroke={3} /></button>
                )}
              </div>
              {active && !l.off && l.alts.length > 0 && (
                <div className="frow-alts" role="group" aria-label={`Instead of ${shown(it)}`}>
                  {l.alts.map((k) => { const alt = foods.get(k); return alt && (
                    <button key={k} className="alt-chip" dir="auto" disabled={busy} onClick={async () => edit(ai, await swapFood(a, li, k))}>{shown(alt)}</button>
                  ); })}
                </div>
              )}
            </div>
          );
        })}
        {groups.filter((g) => !g.lines.length).map((g) => <PlainAction key={g.ai} a={g.a} />)}
      </div>
      {active && (
        <div className="fcard-buttons">
          <button className="btn lg" disabled={busy} onClick={onChange}><Icon name="edit" size={18} />Change</button>
          <button className="btn lg good" disabled={busy || !on.length} onClick={() => resolvePending(chatId, { type: 'apply' })}>
            <Icon name="check" size={18} stroke={2.6} />{busy ? 'Logging…' : `Log (${on.length})`}</button>
        </div>
      )}
      {pick && pickFood && (
        <NumberSheet open onClose={() => setPicking(null)} title={shown(pickFood)} value={portion ? pick.l.item.qty : pick.l.item.grams}
          spec={portion ? { ...PORTION_Q, unit: unitLabel(pick.l.item.unit, true).replace(/^1 /, '') } : { ...BASE_Q, unit: pickFood.unitBase ?? 'g' }}
          onPick={(v) => { void edit(pick.ai, setAmount(pick.a, pick.li, pickFood, v)); setPicking(null); }} />
      )}
    </motion.section>
  );
}

function useDescribed(actions: RequestAction[]) {
  const [d, setD] = useState<Described[] | null>(null);
  const key = JSON.stringify(actions);
  useEffect(() => { let alive = true; Promise.all(actions.map(describeAction)).then((x) => alive && setD(x)); return () => { alive = false; }; }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return d;
}

function PlainAction({ a }: { a: RequestAction }) {
  const [d] = useDescribed([a]) ?? [];
  return <ActionRow d={d ?? { title: a.name, icon: 'bolt', rows: [] }} />;
}
function ActionRow({ d }: { d: Described }) {
  const detail = d.rows.slice(0, 4).map((r) => (r.value ? `${r.label} ${r.value}` : r.label)).join(' · ');
  return (
    <div className="arow">
      <span className="arow-icon" aria-hidden><Icon name={d.icon} size={18} stroke={2.1} /></span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="arow-title">{d.title}</span>
        {detail && <span className="arow-detail" dir="auto">{detail}</span>}
      </span>
    </div>
  );
}

/** Any other change request: friendly rows, Skip / Apply. */
export function RequestCard({ chatId, p, outcome, comment, onChange }: { chatId: string; p: PendingRequest; outcome?: Outcome; comment?: string; onChange?: () => void }) {
  const described = useDescribed(p.actions);
  const active = !outcome;
  const busy = p.status === 'applying';
  const o = outcome ? OUTCOME[outcome] : null;
  return (
    <motion.section className={'rcard' + (active ? '' : ' done')} {...appear} aria-label={`Request: ${p.summary}`}>
      <div className="rcard-head">
        <span className="grow rcard-summary" dir="auto">{p.summary}</span>
        {o && <span className={'req-outcome ' + o.cls}><Icon name={o.icon} size={14} stroke={2.6} />{o.text}</span>}
      </div>
      <div className="rcard-rows">
        {(described ?? p.actions.map((a) => ({ title: a.name, icon: 'bolt', rows: [] }))).map((d, i) => <ActionRow key={i} d={d} />)}
      </div>
      {comment && <p className="req-comment" dir="auto">“{comment}”</p>}
      {active && (
        <div className="fcard-buttons">
          <button className="btn lg" disabled={busy} onClick={onChange}><Icon name="edit" size={18} />Change</button>
          <button className="btn lg primary" disabled={busy} onClick={() => resolvePending(chatId, { type: 'apply' })}><Icon name="check" size={18} stroke={2.6} />{busy ? 'Applying…' : 'Apply'}</button>
        </div>
      )}
      {active && <button className="link rcard-skip" disabled={busy} onClick={() => resolvePending(chatId, { type: 'reject' })}>Skip</button>}
    </motion.section>
  );
}

/** ask_user: all questions in one card, chips, optional free text, one Send. */
export function AskCard({ chatId, questions, answered }: { chatId: string; questions: AskQuestion[]; answered?: { answers?: Record<string, string | string[]>; text?: string } }) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const done = !!answered;
  const pickedOf = (q: AskQuestion): string[] => {
    if (done) { const v = answered!.answers?.[q.id]; return Array.isArray(v) ? v : v ? [v] : []; }
    return sel[q.id] ?? [];
  };
  const toggle = (q: AskQuestion, opt: string) => setSel((s) => {
    const cur = s[q.id] ?? [];
    return { ...s, [q.id]: q.multi ? (cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]) : cur[0] === opt ? [] : [opt] };
  });
  const answers = Object.fromEntries(questions.map((q) => {
    const v = [...(sel[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id].trim()] : [])];
    return [q.id, q.multi ? v : v[v.length - 1] ?? ''];
  }).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
  const count = Object.keys(answers).length;
  return (
    <motion.section className={'ask-card' + (done ? ' done' : '')} {...appear} aria-label="Questions">
      {questions.map((q) => (
        <fieldset key={q.id} className="ask-q" disabled={done}>
          <legend dir="auto">{q.question}{q.multi && <span className="faint"> · pick any</span>}</legend>
          <div className="ask-opts">
            {q.options.map((opt) => {
              const on = pickedOf(q).includes(opt);
              return <button key={opt} type="button" className={'ask-chip' + (on ? ' on' : '')} aria-pressed={on} dir="auto" onClick={() => toggle(q, opt)}>{on && <Icon name="check" size={14} stroke={3} />}{opt}</button>;
            })}
          </div>
          {q.other && !done && <input className="input ask-other" dir="auto" placeholder="Other…" aria-label={`${q.question}: other`} value={other[q.id] ?? ''} onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))} />}
          {done && pickedOf(q).filter((v) => !q.options.includes(v)).map((v) => <p key={v} className="req-comment" dir="auto">“{v}”</p>)}
        </fieldset>
      ))}
      {done && answered?.text && <p className="req-comment" dir="auto">“{answered.text}”</p>}
      {!done && (
        <button className="btn lg block primary" disabled={!count} onClick={() => resolvePending(chatId, { type: 'answer', answers })}>
          <Icon name="arrowUp" size={18} stroke={2.6} />Send{questions.length > 1 ? ` (${count}/${questions.length})` : ''}</button>
      )}
    </motion.section>
  );
}

/** Pick the right card for a request. */
export function RequestBlockCard({ chatId, p, outcome, comment, onChange }: { chatId: string; p: PendingRequest; outcome?: Outcome; comment?: string; onChange?: () => void }) {
  // v1 food requests (stored before amounts were filled in) lack grams/unit: show them as plain rows
  const editable = p.actions.some((a) => isFoodAction(a.name)) && p.actions.filter((a) => isFoodAction(a.name))
    .every((a) => foodLines(a).every((l) => typeof l.item?.grams === 'number' && typeof l.item?.unit === 'string' && typeof l.item?.qty === 'number'));
  return editable
    ? <FoodCard chatId={chatId} p={p} outcome={outcome} onChange={onChange} />
    : <RequestCard chatId={chatId} p={p} outcome={outcome} comment={comment} onChange={onChange} />;
}
