import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FoodEditor, useMyFoods } from '../components/FoodSheets';
import { Icon } from '../components/Icon';
import { NumberPicker, NumberRow, NumberSheet, type NumberSpec } from '../components/NumberPicker';
import { OptionList, PickerRow, range, type Option } from '../components/Picker';
import { weightLog } from '../api/body';
import { goalsSet } from '../api/food';
import { run } from '../api/registry';
import { goalFor } from '../db/food';
import { latestBodyweightKg } from '../db/gym';
import type { Activity, Food, NutritionGoal, Sex } from '../db/types';
import { ACTIVITY_LABEL, KCAL_PER_KG, PROTEIN_G_PER_KG, estimateMaintenance, targetKcal } from '../lib/nutrition';
import { useToday } from '../lib/today';
import { fmtNum } from '../lib/format';

const ACTIVITY_SUB: Record<Activity, string> = {
  sedentary: 'Desk job, little walking', light: 'Some walking, training 2–4×/wk', active: 'On your feet, training most days', very: 'Physical job or hard daily training',
};
const YEAR: NumberSpec = { min: 1930, max: 2012, step: 1, decimals: 0, format: String, keyMin: 1900, keyMax: 2020 };
const HEIGHT: NumberSpec = { min: 130, max: 220, step: 1, decimals: 1, unit: 'cm', keyMin: 100, keyMax: 250 };
const WEIGHT: NumberSpec = { min: 35, max: 250, step: 0.5, decimals: 1, unit: 'kg', format: (w) => `${fmtNum(w)} kg`, keyMin: 30, keyMax: 350 };
const MAINT: NumberSpec = { min: 1000, max: 6000, step: 50, decimals: 0, format: (v) => `${v.toLocaleString()} kcal` };
const RATES: Option<number>[] = range(-1.5, 1.5, 0.25).map((r) => ({ value: r, label: r === 0 ? 'Maintain' : `${r > 0 ? '+' : '−'}${Math.abs(r)} kg / week` }));
const ACTIVITIES: Option<Activity>[] = (Object.keys(ACTIVITY_LABEL) as Activity[]).map((a) => ({ value: a, label: ACTIVITY_LABEL[a], sub: ACTIVITY_SUB[a] }));

interface Draft {
  sex: Sex; birthYear: number; heightCm: number; weightKg: number; activity: Activity; rate: number;
  maintOverride: number | null; useKcal: boolean; kcalOverride: number | null; useProtein: boolean; proteinG: number | null;
  carbsG: number | null; fatG: number | null;
}

function draftFrom(g: NutritionGoal | null, kg: number | undefined): Draft {
  const d = draftBase(g, kg);
  // a stored calorie target that isn't what the formula gives (e.g. set by the agent or typed in) is an override: keep it
  if (g?.kcal != null) { const auto = compute({ ...d, kcalOverride: null }).kcal; if (auto == null || Math.abs(auto - g.kcal) > 1) d.kcalOverride = g.kcal; }
  // same for protein: only an explicit value differing from the 1.6 g/kg default is an override
  if (g?.proteinG != null && compute({ ...d, proteinG: null }).protein === g.proteinG) d.proteinG = null;
  return d;
}

function draftBase(g: NutritionGoal | null, kg: number | undefined): Draft {
  return g ? {
    sex: g.sex, birthYear: g.birthYear, heightCm: g.heightCm, weightKg: kg ?? 80, activity: g.activity, rate: g.rateKgPerWeek,
    maintOverride: g.maintenanceSource === 'manual' ? g.maintenanceKcal : null,
    useKcal: g.kcal != null, kcalOverride: null, useProtein: g.proteinG != null, proteinG: g.proteinG, carbsG: g.carbsG ?? null, fatG: g.fatG ?? null,
  } : { sex: 'male', birthYear: 1998, heightCm: 178, weightKg: kg ?? 80, activity: 'light', rate: -0.5, maintOverride: null, useKcal: true, kcalOverride: null, useProtein: true, proteinG: null, carbsG: null, fatG: null };
}

function compute(d: Draft) {
  const age = new Date().getFullYear() - d.birthYear;
  const formula = estimateMaintenance(d.sex, d.weightKg, d.heightCm, age, d.activity);
  const maintenance = d.maintOverride ?? formula;
  const kcal = d.useKcal ? d.kcalOverride ?? targetKcal(maintenance, d.rate) : null;
  const protein = d.useProtein ? d.proteinG ?? Math.round(d.weightKg * PROTEIN_G_PER_KG / 5) * 5 : null;
  return { formula, maintenance, kcal, protein };
}

async function persist(d: Draft, kgLogged: number | undefined) {
  const { kcal, protein } = compute(d);
  // log the weight first: the goal's formula maintenance uses the latest weigh-in
  if (kgLogged == null || Math.abs(kgLogged - d.weightKg) >= 0.05) await run(weightLog, { kg: d.weightKg });
  // effective today; goals.set updates today's goal in place if one exists. maintenanceKcal null = formula estimate
  await run(goalsSet, {
    sex: d.sex, birthYear: d.birthYear, heightCm: d.heightCm, activity: d.activity, rateKgPerWeek: d.rate,
    maintenanceKcal: d.maintOverride || null, kcal, proteinG: protein, carbsG: d.carbsG, fatG: d.fatG,
  });
}

/** Goals. First visit runs a short setup; afterwards every answer is an editable row.
 *  Saving creates a goal version effective today, so past days keep the targets that applied then. */
export function NutritionPage() {
  const nav = useNavigate();
  const today = useToday();
  const current = useLiveQuery(async () => (await goalFor(today)) ?? null, [today]); // null = none yet
  const kg = useLiveQuery(async () => (await latestBodyweightKg()) ?? null, []);
  const [d, setD] = useState<Draft | null>(null);
  if (!d && current !== undefined && kg !== undefined) setD(draftFrom(current, kg ?? undefined));
  if (!d || current === undefined) return null;
  return current ? <GoalsEditor d={d} setD={setD} kg={kg ?? undefined} onDone={() => nav('/food')} />
    : <Setup d={d} setD={setD} onDone={async () => { await persist(d, kg ?? undefined); nav('/food'); }} onBack={() => nav(-1)} />;
}

/* ------------------------------------------------------------------ */
/* First-run questionnaire: one question per screen                     */
/* ------------------------------------------------------------------ */
function Setup({ d, setD, onDone, onBack }: { d: Draft; setD: (d: Draft) => void; onDone: () => void; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const c = compute(d);
  const steps: { q: string; sub?: string; body: React.ReactNode }[] = [
    { q: 'Sex', sub: 'Used for the resting-energy formula', body: (
      <div className="stack" style={{ gap: 10 }}>
        {(['male', 'female'] as const).map((s) => (
          <button key={s} className={'choice' + (d.sex === s ? ' on' : '')} onClick={() => set({ sex: s })} aria-pressed={d.sex === s}>
            <span className="choice-glyph">{s === 'male' ? '♂' : '♀'}</span>{s === 'male' ? 'Male' : 'Female'}
          </button>
        ))}
      </div>) },
    { q: 'Year born', body: <NumberPicker inline spec={YEAR} value={d.birthYear} onPick={(birthYear) => set({ birthYear })} ariaLabel="Year born" /> },
    { q: 'Height', body: <NumberPicker inline spec={HEIGHT} value={d.heightCm} onPick={(heightCm) => set({ heightCm })} ariaLabel="Height" /> },
    { q: 'Weight', sub: 'Saved as today’s weigh-in', body: <NumberPicker inline spec={WEIGHT} value={d.weightKg} onPick={(weightKg) => set({ weightKg })} ariaLabel="Weight" /> },
    { q: 'How active are you?', body: <OptionList options={ACTIVITIES} value={d.activity} onPick={(activity) => set({ activity })} ariaLabel="Activity" /> },
    { q: 'Your goal', sub: d.rate === 0 ? 'Keep your weight steady' : `${Math.round(Math.abs(d.rate * KCAL_PER_KG / 7))} kcal/day ${d.rate < 0 ? 'deficit' : 'surplus'}`,
      body: <OptionList options={RATES} value={d.rate} onPick={(rate) => set({ rate })} ariaLabel="Weekly change" /> },
    { q: 'Daily goals', sub: 'Both optional. You can log without goals.', body: (
      <div className="stack" style={{ gap: 10 }}>
        <TargetToggle label="Calories" value={c.kcal} unit="kcal" on={d.useKcal} onToggle={(useKcal) => set({ useKcal })} note={`maintenance ≈ ${c.maintenance.toLocaleString()}`} />
        <TargetToggle label="Protein" value={c.protein} unit="g" on={d.useProtein} onToggle={(useProtein) => set({ useProtein })} note={`${PROTEIN_G_PER_KG} g per kg`} />
      </div>) },
  ];
  const last = step === steps.length - 1;
  const s = steps[step];
  return (
    <div className="page no-tabs setup" data-role="food">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => (step ? setStep(step - 1) : onBack())}><Icon name="chevronLeft" /></button>
        <div className="grow setup-dots" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((_, i) => <i key={i} className={i <= step ? 'on' : ''} />)}
        </div>
        <span style={{ width: 44 }} />
      </header>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }} className="setup-step">
          <h1 className="setup-q">{s.q}</h1>
          {s.sub && <p className="muted setup-sub">{s.sub}</p>}
          <div style={{ marginTop: 24 }}>{s.body}</div>
        </motion.div>
      </AnimatePresence>
      <div className="setup-foot">
        <button className="btn primary lg block" onClick={() => (last ? onDone() : setStep(step + 1))}>
          {last ? <><Icon name="check" size={20} stroke={2.6} /> Done</> : <>Next <Icon name="chevronRight" size={18} stroke={2.4} /></>}
        </button>
      </div>
    </div>
  );
}

function TargetToggle({ label, value, unit, on, onToggle, note }: { label: string; value: number | null; unit: string; on: boolean; onToggle: (v: boolean) => void; note: string }) {
  return (
    <label className="card row" style={{ cursor: 'pointer', padding: '14px 16px' }}>
      <span className="grow">
        <span style={{ fontWeight: 700, display: 'block' }}>{label}</span>
        <span className="muted" style={{ fontSize: '0.8125rem' }}>{note}</span>
      </span>
      {on && value != null && <span className="num" style={{ fontWeight: 800, fontSize: '1.25rem', marginRight: 10 }}>{value.toLocaleString()}<span className="muted" style={{ fontSize: '0.8125rem', fontWeight: 600 }}> {unit}</span></span>}
      <span className="switch"><input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} /><span /></span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Editing afterwards                                                   */
/* ------------------------------------------------------------------ */
function GoalsEditor({ d, setD, kg, onDone }: { d: Draft; setD: (d: Draft) => void; kg: number | undefined; onDone: () => void }) {
  const myFoods = useMyFoods();
  const [editFood, setEditFood] = useState<Food | null>(null);
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const c = compute(d);
  return (
    <div className="page" data-role="food">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => history.back()}><Icon name="chevronLeft" /></button>
        <h1 className="small">Goals</h1>
        <span style={{ width: 44 }} />
      </header>

      <div className="section-title">You</div>
      <div className="list">
        <div className="list-item"><span className="grow title">Sex</span>
          <div className="seg" style={{ width: 190 }}>{(['male', 'female'] as const).map((s) => <button key={s} aria-pressed={d.sex === s} onClick={() => set({ sex: s })}>{s === 'male' ? 'Male' : 'Female'}</button>)}</div>
        </div>
        <NumberRow label="Born" spec={YEAR} value={d.birthYear} onChange={(birthYear) => set({ birthYear })} title="Year born" />
        <NumberRow label="Height" spec={HEIGHT} value={d.heightCm} onChange={(heightCm) => set({ heightCm })} />
        <NumberRow label="Weight" sub={kg == null ? 'Saved as a weigh-in' : undefined} spec={WEIGHT} value={d.weightKg} onChange={(weightKg) => set({ weightKg })} />
        <PickerRow label="Activity" sub={ACTIVITY_SUB[d.activity]} options={ACTIVITIES} value={d.activity} onChange={(activity) => set({ activity })} />
        <PickerRow label="Weekly change" options={RATES} value={d.rate} onChange={(rate) => set({ rate, kcalOverride: null })} />
      </div>

      <div className="section-title">Maintenance</div>
      <div className="card row">
        <div className="grow">
          <div className="big-value num">{c.maintenance.toLocaleString()}<span className="muted" style={{ fontSize: '0.875rem', fontWeight: 600 }}> kcal</span></div>
          <div className="muted" style={{ fontSize: '0.8125rem' }}>{d.maintOverride ? 'Set by you' : 'Estimate'} · refines from your logs later</div>
        </div>
        <ValueButton icon label="Maintenance" value={c.maintenance} spec={MAINT} onChange={(x) => set({ maintOverride: x, kcalOverride: null })} />
      </div>
      {d.maintOverride && <button className="link" onClick={() => set({ maintOverride: null })}>Use estimate ({c.formula.toLocaleString()})</button>}

      <div className="section-title">Daily goals</div>
      <div className="list">
        <OptRow label="Calories" unit="kcal" on={d.useKcal} value={c.kcal} step={50} min={800} max={6000}
          onToggle={(useKcal) => set({ useKcal })} onChange={(kcalOverride) => set({ kcalOverride })} />
        <OptRow label="Protein" unit="g" on={d.useProtein} value={c.protein} step={5} min={20} max={400}
          sub={c.protein ? `${(c.protein / d.weightKg).toFixed(1)} g/kg` : undefined}
          onToggle={(useProtein) => set({ useProtein })} onChange={(proteinG) => set({ proteinG })} />
        <OptRow label="Carbs" unit="g" on={d.carbsG != null} value={d.carbsG} step={5} min={0} max={800}
          onToggle={(on) => set({ carbsG: on ? Math.round(((c.kcal ?? c.maintenance) * 0.45) / 4 / 5) * 5 : null })} onChange={(carbsG) => set({ carbsG })} />
        <OptRow label="Fat" unit="g" on={d.fatG != null} value={d.fatG} step={5} min={0} max={400}
          onToggle={(on) => set({ fatG: on ? Math.round(((c.kcal ?? c.maintenance) * 0.28) / 9 / 5) * 5 : null })} onChange={(fatG) => set({ fatG })} />
      </div>

      <button className="btn primary lg block" style={{ marginTop: 20 }} onClick={async () => { await persist(d, kg); onDone(); }}>
        <Icon name="check" size={20} stroke={2.6} /> Save
      </button>

      {myFoods.length > 0 && <>
        <div className="section-title">My foods & recipes</div>
        <div className="list">
          {myFoods.map((f) => (
            <button key={f.id} className="list-item pressable" onClick={() => setEditFood(f)}>
              <span className="grow" style={{ minWidth: 0 }}><span className="title ellipsis bidi-start" dir="auto" style={{ display: 'block' }}>{f.name}</span>
                <span className="sub">{[f.brand, f.source === 'off' ? 'Scanned' : f.source === 'recipe' ? 'Recipe' : null].filter(Boolean).join(' · ') || 'My food'}</span></span>
              <span className="num muted t-13">{Math.round(f.per100.kcal)} kcal / 100 {f.unitBase === 'ml' ? 'ml' : 'g'}</span>
            </button>
          ))}
        </div>
      </>}
      <FoodEditor open={!!editFood} food={editFood ?? undefined} onClose={() => setEditFood(null)} />
    </div>
  );
}

function OptRow({ label, unit, on, value, step, min, max, sub, onToggle, onChange }: {
  label: string; unit: string; on: boolean; value: number | null; step: number; min: number; max: number; sub?: string;
  onToggle: (on: boolean) => void; onChange: (v: number) => void;
}) {
  return (
    <div className="list-item" style={{ flexWrap: 'wrap' }}>
      <span className="grow"><span className="title">{label}</span>{sub && on && <span className="sub" style={{ display: 'block' }}>{sub}</span>}</span>
      {on && value != null && <ValueButton label={`${label} goal`} value={value} spec={{ min, max, step, decimals: 0, format: (x) => `${x.toLocaleString()} ${unit}`, keyMin: min, keyMax: max }} onChange={onChange} />}
      <span className="switch" style={{ marginLeft: 6 }}><input type="checkbox" aria-label={`${label} goal`} checked={on} onChange={(e) => onToggle(e.target.checked)} /><span /></span>
    </div>
  );
}

/** Tappable value pill that opens the list + keypad sheet. */
function ValueButton({ label, value, spec, onChange, icon }: { label: string; value: number; spec: NumberSpec; onChange: (v: number) => void; icon?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {icon ? <button type="button" className="icon-btn filled" aria-haspopup="dialog" aria-label={`Set ${label.toLowerCase()}`} onClick={() => setOpen(true)}><Icon name="pencil" size={18} /></button> : <button type="button" className="btn num" style={{ minWidth: 116, fontWeight: 700, justifyContent: 'flex-end' }} aria-haspopup="dialog" aria-label={`${label}: ${spec.format?.(value) ?? value}`} onClick={() => setOpen(true)}>
        {spec.format?.(value) ?? value}
      </button>}
      <NumberSheet open={open} onClose={() => setOpen(false)} title={label} value={value} onPick={onChange} spec={spec} />
    </>
  );
}
