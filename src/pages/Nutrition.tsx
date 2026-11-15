import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FoodEditor, useMyFoods } from '../components/FoodSheets';
import { Icon } from '../components/Icon';
import { Stepper } from '../components/ItemSettings';
import { alive, db, newRecord, save } from '../db/db';
import { goalFor } from '../db/food';
import { latestBodyweightKg } from '../db/gym';
import type { Activity, Food, NutritionGoal, Sex } from '../db/types';
import { ACTIVITY_LABEL, KCAL_PER_KG, PROTEIN_G_PER_KG, dateKey, estimateMaintenance, targetKcal } from '../lib/nutrition';
import { WeighInSheet } from './Weight';

const RATES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5];

/** Goals: profile → maintenance estimate → weekly rate → calorie & protein targets.
 *  Saving creates a new goal version effective today, so past days keep their old targets. */
export function NutritionPage() {
  const nav = useNavigate();
  const today = dateKey();
  // null = loaded, no goal yet (useLiveQuery uses undefined for "still loading")
  const current = useLiveQuery(async () => (await goalFor(today)) ?? null, [today]);
  const kg = useLiveQuery(() => latestBodyweightKg(), []);
  const myFoods = useMyFoods();
  const [weighing, setWeighing] = useState(false);
  const [editFood, setEditFood] = useState<Food | null>(null);

  const [v, setV] = useState<{ sex: Sex; birthYear: number; heightCm: number; activity: Activity; rate: number; maintOverride: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null } | null>(null);
  if (!v && current !== undefined) {
    setV(current ? {
      sex: current.sex, birthYear: current.birthYear, heightCm: current.heightCm, activity: current.activity, rate: current.rateKgPerWeek,
      maintOverride: current.maintenanceSource === 'manual' ? current.maintenanceKcal : null, proteinG: current.proteinG, carbsG: current.carbsG ?? null, fatG: current.fatG ?? null,
    } : { sex: 'male', birthYear: 1998, heightCm: 178, activity: 'light', rate: -0.5, maintOverride: null, proteinG: null, carbsG: null, fatG: null });
  }
  if (!v) return null;

  const age = new Date().getFullYear() - v.birthYear;
  const formula = kg ? estimateMaintenance(v.sex, kg, v.heightCm, age, v.activity) : null;
  const maintenance = v.maintOverride ?? formula;
  const kcal = maintenance ? targetKcal(maintenance, v.rate) : null;
  const protein = v.proteinG ?? (kg ? Math.round(kg * PROTEIN_G_PER_KG) : null);
  const set = (p: Partial<typeof v>) => setV({ ...v, ...p });

  const saveGoal = async () => {
    if (!maintenance || !kcal || !protein) return;
    const fields = {
      effectiveFrom: today, sex: v.sex, birthYear: v.birthYear, heightCm: v.heightCm, activity: v.activity, rateKgPerWeek: v.rate,
      maintenanceKcal: maintenance, maintenanceSource: v.maintOverride ? 'manual' as const : 'formula' as const,
      kcal, proteinG: protein, carbsG: v.carbsG, fatG: v.fatG,
    };
    const sameDay = (await db.goals.where('effectiveFrom').equals(today).filter(alive).first());
    await save('goals', sameDay ? { ...sameDay, ...fields } : newRecord(fields) as NutritionGoal);
    nav('/food');
  };

  return (
    <div className="page" data-role="food">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" /></button>
        <h1 className="small">Goals</h1>
        <span style={{ width: 44 }} />
      </header>

      <div className="section-title">You</div>
      <div className="list">
        <div className="list-item"><span className="grow title">Sex</span>
          <div className="seg" style={{ width: 150 }}>{(['male', 'female'] as const).map((s) => <button key={s} aria-pressed={v.sex === s} onClick={() => set({ sex: s })}>{s === 'male' ? '♂' : '♀'}</button>)}</div>
        </div>
        <div className="list-item"><span className="grow title">Born</span><Stepper label="Birth year" value={v.birthYear} min={1930} max={2015} onChange={(birthYear) => set({ birthYear })} /></div>
        <div className="list-item"><span className="grow title">Height</span><Stepper label="Height" value={v.heightCm} min={120} max={230} format={(x) => `${x} cm`} onChange={(heightCm) => set({ heightCm })} /></div>
        <button className="list-item pressable" onClick={() => setWeighing(true)}>
          <span className="grow title">Weight</span>
          <span className={kg ? 'num' : 'due'} style={{ fontWeight: 650 }}>{kg ? `${kg.toFixed(1)} kg` : '● Log weight'}</span>
          <Icon name="chevronRight" className="chev" size={18} />
        </button>
      </div>

      <div className="section-title">Activity</div>
      <div className="seg">{(Object.keys(ACTIVITY_LABEL) as Activity[]).map((a) => <button key={a} aria-pressed={v.activity === a} onClick={() => set({ activity: a })} style={{ fontSize: '0.8125rem' }}>{ACTIVITY_LABEL[a]}</button>)}</div>

      <div className="section-title">Maintenance</div>
      <div className="card row">
        <div className="grow">
          <div className="big-value num">{maintenance ? maintenance.toLocaleString() : '–'}<span className="muted" style={{ fontSize: '0.875rem', fontWeight: 600 }}> kcal</span></div>
          <div className="muted" style={{ fontSize: '0.8125rem' }}>{v.maintOverride ? 'Set by you' : 'Estimate · Mifflin-St Jeor × activity'} · refines from your logs later</div>
        </div>
        <Stepper label="Maintenance" value={maintenance ?? 2000} min={1000} max={6000} step={50} format={() => ''} onChange={(x) => set({ maintOverride: x })} />
      </div>
      {v.maintOverride && <button className="link" onClick={() => set({ maintOverride: null })}>Use estimate</button>}

      <div className="section-title">Weekly change</div>
      <div className="chips" style={{ flexWrap: 'wrap' }}>
        {RATES.map((r) => <button key={r} className="chip num" aria-pressed={v.rate === r} onClick={() => set({ rate: r })}>{r > 0 ? '+' : ''}{r} kg</button>)}
      </div>
      <p className="faint" style={{ fontSize: '0.75rem', margin: '6px 6px 0' }}>{v.rate === 0 ? 'Maintain.' : `${Math.round(Math.abs(v.rate * KCAL_PER_KG / 7))} kcal/day ${v.rate < 0 ? 'deficit' : 'surplus'} (≈7,700 kcal per kg — a rough rule).`}</p>

      <div className="section-title">Daily targets</div>
      <div className="list">
        <div className="list-item"><span className="grow title">Calories</span><b className="num" style={{ fontSize: '1.25rem' }}>{kcal ? kcal.toLocaleString() : '–'}</b></div>
        <div className="list-item"><span className="grow"><span className="title">Protein</span>{kg && <span className="sub" style={{ display: 'block' }}>{(protein! / kg).toFixed(1)} g/kg</span>}</span>
          <Stepper label="Protein grams" value={protein ?? 120} min={30} max={400} step={5} format={(x) => `${x} g`} onChange={(x) => set({ proteinG: x })} />
        </div>
        <OptionalTarget label="Carbs" value={v.carbsG} onChange={(carbsG) => set({ carbsG })} def={kcal ? Math.round(kcal * 0.45 / 4 / 5) * 5 : 200} />
        <OptionalTarget label="Fat" value={v.fatG} onChange={(fatG) => set({ fatG })} def={kcal ? Math.round(kcal * 0.28 / 9 / 5) * 5 : 70} />
      </div>

      <button className="btn primary lg block" style={{ marginTop: 20 }} onClick={saveGoal} disabled={!kcal || !protein}>
        <Icon name="check" size={20} stroke={2.6} /> Save goals
      </button>
      {!kg && <p className="due" style={{ textAlign: 'center', fontSize: '0.875rem' }}>Log your weight first — the estimate needs it.</p>}

      {myFoods.length > 0 && <>
        <div className="section-title">My foods</div>
        <div className="list">
          {myFoods.map((f) => (
            <button key={f.id} className="list-item pressable" onClick={() => setEditFood(f)}>
              <span className="grow" style={{ minWidth: 0 }}><span className="title ellipsis" style={{ display: 'block' }}>{f.name}</span>
                <span className="sub">{[f.brand, f.source === 'off' ? 'scanned' : null].filter(Boolean).join(' · ') || 'mine'}</span></span>
              <span className="num muted" style={{ fontSize: '0.8125rem' }}>{Math.round(f.per100.kcal)}/100g</span>
            </button>
          ))}
        </div>
      </>}

      <WeighInSheet open={weighing} onClose={() => setWeighing(false)} />
      <FoodEditor open={!!editFood} food={editFood ?? undefined} onClose={() => setEditFood(null)} />
    </div>
  );
}

function OptionalTarget({ label, value, onChange, def }: { label: string; value: number | null; onChange: (v: number | null) => void; def: number }) {
  return (
    <div className="list-item">
      <span className="grow title">{label}</span>
      {value == null
        ? <button className="pill-btn" aria-label={`Set ${label.toLowerCase()} target`} onClick={() => onChange(def)}><Icon name="plus" size={16} /></button>
        : <>
            <Stepper label={`${label} grams`} value={value} min={0} max={800} step={5} format={(x) => `${x} g`} onChange={onChange} />
            <button className="icon-btn sm" aria-label={`Remove ${label.toLowerCase()} target`} onClick={() => onChange(null)}><Icon name="close" size={16} /></button>
          </>}
    </div>
  );
}
