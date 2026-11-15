# Tap In — v1 spec

Written down from the user's own description on 2026-11-15. Platform notes are in the `iphone-pwa` skill and AI notes in the `pwa-ai-layer` skill.

**What Tap In is:** one app that replaces Alpha Progression (gym), MyNetDiary (food and weight), and the missing supplement tracker. **The goal of v1 is logging only.** Log everything fast and cleanly, so analysis, progression charts and achievements can be built on the data later. If the data model is wrong we can migrate later, since only the user (and maybe friends) has data, but storing **raw facts** keeps that rare.

## Principles

- **Fast.** Every log is a local write that shows up at once and syncs in the background (local-first, see the skill).
- **Simple UI** in the style of Alpha Progression. No clutter: calories, protein, carbs and fat only.
- **Store raw, compute later.** Save exactly what happened (weight, reps, RIR, timestamps, the bodyweight at that time). Estimates like e1RM and maintenance are always derived from that data, never stored as the only copy.
- **Every record is timestamped**, so later analysis can line anything up against anything else (supplement → weight trend, sleep → strength, and so on).
- **Every feature can be turned off** in Settings: whole modules (gym, food, supplements, daily check-ins, AI) and smaller features (rest timer, RPE/RIR column, carb/fat targets, warm-up sets, reminders). Turned-off features vanish from the UI completely. The app is only as busy as the user makes it.
- **Every calculation is based on published science.** e1RM, 10RM, drop-set weights, rest defaults, maintenance, BMR, and anything added later. Each formula is cited in the code and in "Science sources" below. Before implementing a formula, check the citation is real and says what we claim. If no solid literature exists, label the number in the UI as a rough guide.
- **Works on desktop too.** The same app is responsive. The phone is for logging, and a PC browser is nice for looking at history and analytics. Wider screens get multi-column layouts.
- **Units:** kg by default, with a setting for kg/lb. Weights are always stored in kg along with the unit they were entered in, so switching units never changes the data.

## Global

- **Profile:** sex, birth year, height, units (kg/lb, cm/in), and activity level (used only for the first maintenance estimate).
- **Bodyweight log:** date, time, weight. The reminder interval is configurable (default weekly) and sent as a server push. The latest weight is available to the whole app.
- **Progress photos** (optional, can be turned off):
  - Attach photos to a weigh-in, or add them on their own. Poses are labelled front / side / back / custom.
  - A faint overlay of the last photo of the same pose helps line up the shot.
  - Later: a side-by-side and slider comparison, plus a timeline next to the weight trend.
  - **Storage:**
    - Photos are resized and compressed on the phone, then kept locally in IndexedDB.
    - They upload to a **private** bucket (Cloudflare R2, free 10 GB) and are only served to their owner, through an authenticated backend route.
    - No public URLs, never sent to the AI.
    - Location (EXIF) data is stripped before upload.
- **Settings:** units, reminders, export/import JSON, sync status, and AI provider connection.

## Gym

**Exercise library**
- Comes with pre-made exercises (seed candidate: [free-exercise-db](https://github.com/yuhonas/free-exercise-db), public domain, about 800 exercises with muscles, equipment and images). The user can add custom exercises.
- Each exercise has a **load type**:
  - `weighted`: barbell, dumbbell or machine. The logged weight is the load.
  - `bodyweight_plus`: weighted pull-ups or dips. The added weight is logged. Total = bodyweight snapshot + added.
  - `assisted`: assisted pull-up machine. Total = bodyweight − assistance.
  - `bodyweight`: push-ups and similar. Total = bodyweight × an optional fraction.
- Both **added** and **total** load are available for every set. The bodyweight snapshot is taken from the latest weigh-in when the set is logged.
- **`mechanic`: compound or isolation.** It comes from free-exercise-db's `mechanic` field and sets the default rest time.
- **`unilateral`: yes/no.** free-exercise-db has no such field, so we add our own. It's guessed from the name for the seed data ("single-arm", "one-leg", "alternating", "Bulgarian", "lunge"…) and the user can change it per exercise. For unilateral exercises, each set records **left and right separately** (reps, effort, and weight if it differs).

**Plans**
- A plan is an ordered **list of workouts**, not tied to weekdays. The app suggests the next workout in the rotation, and you can pick any.
- A workout is an ordered list of exercises. Each exercise has:
  - a target number of sets
  - optional target reps (or a rep range)
  - a rest time
  - notes
- **Rest time:** the default comes from `mechanic` (isolation 1:30, compound 3:00) and can be changed per exercise in the plan. Alternatively, choose **count-up** (a stopwatch since the last set, no target).
- **Supersets:** two or more exercises grouped so their sets alternate (A1, B1, A2, B2…). Rest runs after each full round.
- **Drop sets:** a set can have drop steps after it. See below.

**Active workout screen (modelled on Alpha Progression)**
1. **Exercise strip at the top:**
   - Every exercise in the session. Done ones show a ✓, the current one is highlighted, and later ones look normal.
   - **Drag to reorder.**
   - Supersets are drawn as one joined "tube" around their exercises.
2. **Current exercise:** name, image, and a ⋯ menu (replace, remove, edit sets/targets/rest, notes, superset with…).
3. **Set rows:** set number | weight | reps | RIR/RPE.
   - Tapping weight opens a **big scroll wheel** that steps through common machine and plate weights. The kg/lb switch sits right there.
   - Unilateral exercises show an L/R pair per set.
   - Drop steps appear indented under their set, with the **suggested weight already filled in** (editable).
   - Warm-up sets are marked and excluded from progression.
4. **History:** last session's weight × reps for each set. Tapping it opens that exercise's full history page, which is where per-exercise analytics will go later.

**Session rules**
- Starting a workout starts the session timer and keeps the screen on (wake lock).
- **Rest timer:** starts when a set is checked. Shown in the app.
  - A locked-phone alert would need a server push and may arrive a second or two late. Planned, can be turned off.
- **Anything you can edit in a plan, you can edit mid-workout:**
  - add, remove or replace exercises
  - change set counts, targets or rest
  - create or break supersets
  - reorder exercises
- The session keeps its own copy of the structure. **On finish, if anything differs from the plan, ask:** "Update the plan with these changes?" (yes / just this time).
- **Effort:** you can enter RPE or RIR, and the app stores both values. The input mode is a setting and can be switched per set. RPE ≈ 10 − RIR on the RIR-based RPE scale (Zourdos 2016), so one stored effort value can display either way. Half steps are allowed. Effort is optional.
- Finishing saves the duration. Sessions can be edited afterwards.

**Analytics page (later):** per exercise or overall. History, e1RM/10RM trends, volume, bodyweight, and so on. On desktop it gets more room.

**Later (not v1):** e1RM and 10RM progression charts, PRs and achievements.
- e1RM will come from reps + RIR (reps-to-failure = reps + RIR), using Epley/Brzycki or an RPE table (Tuchscherer). 10RM is derived from e1RM.
- The raw data above is enough for all of this.

## Food

**Setup**
- A short questionnaire gives the first maintenance estimate: Mifflin-St Jeor × activity factor.
- **Goal:** lose, maintain or gain at X kg per week, which sets a daily calorie target.
- A protein target is required. Carb and fat targets are optional.

**Logging**
- Meals: breakfast, lunch, dinner, snacks. These are just labels and can be edited.
- Ways to add food:
  1. **Search** generic foods, your own foods and recipes, and recent items.
  2. **Barcode scan** with the camera.
  3. **Meal photo → AI.**
  4. **Quick add** of raw calories and macros.
- Amounts can be in grams, servings, or the food's own units (1 egg, 1 slice).
- **Custom foods and recipes:** a recipe is a list of ingredients plus the number of servings or the total cooked weight.

**Food database (the expected first hurdle)**
- **Generic foods:** USDA FoodData Central (public domain). Ship a trimmed subset (Foundation + SR Legacy, about 8k foods) with the app, so search works offline and instantly.
- **Barcodes:** Open Food Facts API (free, open data, strong on EU/international products). Look up on demand and cache in the user's foods. When a barcode is missing or wrong, the user can fix it or create the food, and it is saved as a custom food.
- Every logged item stores a **snapshot of its nutrition**, so editing a food later doesn't rewrite history.

**AI meal photo**
- Photo → the model returns items, each matched to a food in the database (or a new estimated food), with grams and confidence.
- The model always tries to get it in one go. **If a detail changes the answer a lot and the photo can't show it** (oil vs water tuna, fried vs grilled, sauce, portion size), it asks a short multiple-choice question before logging.
- The user always reviews and edits before saving. Runs through the AI adapter (ChatGPT plan first, API fallback).

**Adaptive maintenance**
- **Weight trend:** a smoothed bodyweight series (exponential moving average) instead of raw weigh-ins, because water weight is noise.
- Weekly: maintenance ≈ average intake − (trend change in kg × ~7700 kcal ÷ days).
- **Noise protection:**
  - Only use days that were fully logged. A missing day is never treated as 0 kcal; the user can mark a day as complete or incomplete.
  - Require a minimum amount of data (about 2 weeks).
  - Blend the new estimate with the previous one instead of jumping, and cap the weekly change.
- The calorie target updates from the new maintenance estimate. Show it as a suggestion the user can accept.

## Supplements and medications

**Items**
- Each item has a name, form (capsule, powder, injection, liquid…), and default dose with unit (mg, mcg, g, IU, ml, units).
- Route: oral, subcutaneous, or other.
- Notes, and optionally the stock remaining.

**Schedules**
- Repeat options: daily at time(s), specific weekdays, every N days, or weekly (for example retatrutide).
- Optional on/off cycles.
- **Dose changes over time** (titration: 2 mg → 4 mg …) are kept as history, not overwritten.

**Stacks**
- A group of items taken together, such as the "morning stack". Checking the stack off logs every item in it in one go.

**Logging**
- Each check-off stores the time actually taken and the dose actually taken (defaults to the scheduled dose).
- Injections can also store the injection site.
- Taking something off-schedule ("as needed") is allowed.
- A skipped dose is recorded as skipped, not missing.

**Reminders:** server push at the scheduled times.

**Notes:** a log of side effects and subjective notes, timestamped.

## Data model sketch (all records: client UUID, createdAt, updatedAt, deletedAt)

```
profile, settings
bodyweight_entries(date, time, kg)
progress_photos(taken_at, bodyweight_entry_id?, pose: front|side|back|custom, blob_key, width, height)
exercises(name, load_type, bw_fraction?, muscles[], equipment, custom)
plans(name, workout_ids[] ordered)
exercises += (mechanic: compound|isolation, unilateral: bool, image)
workouts(plan_id, name, items[{exercise_id, order, superset_group?, target_sets, target_reps?,
         rest: {mode: timer|countup, seconds?}, drop_steps?, notes}])
sessions(workout_id?, started_at, ended_at, notes, structure_snapshot)   // its own editable copy of items
sets(session_id, exercise_id, set_no, side: both|left|right, kind: warmup|working|drop,
     parent_set_id?,  // drop steps point at their main set
     load_kg?, load_type,  // weighted: the weight; bodyweight: added weight; assisted: assistance
     input_unit: kg|lb,
     bodyweight_kg_snapshot, reps, rpe?, rir?, effort_input: rpe|rir, done_at)
checkins(date, sleep_h?, sleep_quality?, energy?, hunger?, mood?, note?)   // daily, opt-in
foods(source: usda|off|custom|ai, barcode?, name, brand?, per100g{kcal,p,c,f}, servings[])
recipes(name, ingredients[{food_id, g}], servings, cooked_weight_g?)
food_entries(date, meal, food_id|recipe_id|quick, amount, unit, grams, nutrition_snapshot{kcal,p,c,f}, photo_id?)
day_status(date, complete: bool)
nutrition_goals(effective_from, kcal, protein_g, carbs_g?, fat_g?, maintenance_kcal, rate_kg_per_week)
supplements(name, form, unit, route, notes, stock?)
supplement_schedules(supplement_id|stack_id, rule, times[], effective_from, dose)
stacks(name, items[{supplement_id, dose}])
supplement_logs(supplement_id, scheduled_for?, taken_at, dose, unit, site?, status: taken|skipped)
notes(at, tags[], text)
```

## Daily check-in (optional, can be turned off)

About 5 seconds a day: sleep hours and quality, energy, hunger, mood (1–5), and an optional note. It exists to support the "what worked" analysis.

## Decisions (2026-11-15)

- **Hosting:** probably Cloudflare Pages, since the repo is private. To be decided when deploying.
- **Rest timer:** yes, with defaults by mechanic, set per exercise, or count-up.
- **Daily check-ins:** yes, opt-in. Every feature can be turned off.
- **Units:** kg by default, lb available in settings and from the weight wheel.
- **History import:** none in the app. The user will export from Alpha Progression and MyNetDiary later, and we import it once by script.
- **UI reference:** Alpha Progression's active workout screen, as described above.

## Science sources

Every formula in the code links back here. **Verify each source before implementing** (rows below verified 2026-11-15 against PubMed/journal records; the BMR, weight-trend and maintenance rows are verified when food is built) (it must be real, and the claim must match). Add a new row whenever a calculation is added.

| Calculation | Approach | Source |
|---|---|---|
| Effort scale | RPE = 10 − RIR, half steps allowed | Zourdos et al. 2016, *JSCR*, "Novel resistance training–specific RPE scale measuring repetitions in reserve"; Helms et al. 2016, *Strength Cond J* |
| e1RM | Reps to failure = reps + RIR, then Epley (w × (1 + r/30)) or Brzycki (w × 36/(37 − r)). Treat estimates past about 10–12 reps to failure as less reliable and weight them lower. | Epley 1985; Brzycki 1993, *JOPERD*; Reynolds, Gordon & Robergs 2006, *JSCR* (accuracy falls at higher reps) |
| 10RM / nRM | Invert the same formula from e1RM | As above |
| Drop-set weight | Drop by 20% per step (the literature typically uses 20–25%), rounded to the nearest weight the equipment allows | Coleman et al. 2023, *Sports Med Open*, "Effects of Drop Sets on Skeletal Muscle Hypertrophy" (PMC10390395); background: Schoenfeld & Grgic 2018, *Strength Cond J* 40(6):95–98 |
| Rest defaults | Compound 3 min, isolation 1.5 min (the user's choice). Longer rest supports strength and hypertrophy on compound lifts. | Schoenfeld et al. 2016, *JSCR* (1 vs 3 min rest) |
| BMR | Mifflin-St Jeor: 10·kg + 6.25·cm − 5·age + 5 (male) / −161 (female). **Verified.** | Mifflin et al. 1990, *Am J Clin Nutr* 51(2):241–247 |
| Activity multiplier (PAL) | Mostly sitting 1.40, light 1.55, active 1.85, very active 2.20 (the lower bound / midpoints of FAO's categories). Starting estimate only. **Verified.** | FAO/WHO/UNU 2004, *Human energy requirements*, Table 5.3 (sedentary/light 1.40–1.69, active 1.70–1.99, vigorous 2.00–2.40) |
| Protein default | 1.6 g/kg/day; the user can change it. **Verified.** | Morton et al. 2018, *Br J Sports Med* 52(6):376–384 (no further FFM gains above ~1.62 g/kg/day) |
| Quick-add calories from macros | 4 kcal/g protein, 4 kcal/g carbohydrate, 9 kcal/g fat (Atwater general factors), used only when kcal is left blank | Atwater general factors, as used in USDA food composition data |
| Goal hit (calendar dot) | Calories within ±10% of target and protein ≥ 95% of target. Our own tolerance, not a published standard. | — (labelled as a rough guide) |
| Weight trend | Exponentially smoothed moving average of weigh-ins | Walker, *The Hacker's Diet* (method); note this one is not peer-reviewed |
| Adaptive maintenance | Intake − trend change × energy density. ~7700 kcal/kg is a simplification, and the true value varies with body composition. | Hall 2008, *Int J Obes*, "What is the required energy deficit per unit weight loss?" |

## Food data sources (bundled, offline)

| Data | Source & licence | Refresh |
|---|---|---|
| Generic foods (English) | USDA FoodData Central, SR Legacy 2018 — public domain | `node scripts/build-foods.mjs <unzipped dir>` |
| Israeli generic foods & dishes (Hebrew + English) | Israel Ministry of Health, Tzameret (data.gov.il "nutrition-database", open licence). The direct CSV links return 403 from abroad; use the datastore API (`datastore_search?resource_id=…&limit=32000`) | `node scripts/build-israel.mjs <tz dir> <off dir>` |
| Israeli packaged products (barcodes) | Open Food Facts, products sold in Israel — ODbL. API search is capped at 100/page and throttles bulk pulls after ~30 pages; the bundle holds what was fetched (708 complete + name-only rows) and live lookup covers the rest | same script; re-run the paged download slowly |

Barcode lookup order: your saved foods → bundled Israeli products → Open Food Facts online → name-only prefill → manual entry.
Search: `src/lib/search.ts` (typo-tolerant, word-order free, aliases, usage-ranked), shared by foods and exercises.

## Supplements (built 2026-11-15)

- `Supplement`: form, route (injection → subcutaneous), unit, **dose history** (`doses: {from, amount}[]`, titration never overwrites), schedule (daily / specific weekdays / every N days / weekly / as needed, times, start date, optional on/off cycle), optional stock (decremented on take).
- `Stack`: members due at the same time are grouped and checked off in one tap (schedules stay on each supplement).
- `SuppLog`: one row per scheduled dose (date + slot) or as-needed take: taken/skipped, actual amount, time taken, injection site.
- Injection sites rotate: the least recently used site is pre-selected (common practice for repeated injections; a suggestion, not a calculation).
- `Note`: timestamped journal, taggable with supplements and "side effect" — for later correlation.
- Reminders need the backend (Web Push); until then the checklist and the Home widget show what's due.
