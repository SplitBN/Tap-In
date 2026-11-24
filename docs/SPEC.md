# Tap In — v1 spec

Written down from the user's own description on 2026-11-15. Platform notes are in the `iphone-pwa` skill and AI notes in the `pwa-ai-layer` skill.

**What Tap In is:** one app that replaces Alpha Progression (gym), MyNetDiary (food and weight), and the missing supplement tracker. **The goal of v1 is logging only.** Log everything fast and cleanly, so analysis, progression charts and achievements can be built on the data later. If the data model is wrong we can migrate later, since only the user (and maybe friends) has data, but storing **raw facts** keeps that rare.

## Principles

- **Fast.** Every log is a local write that shows up at once and syncs in the background (local-first, see the skill).
- **Simple UI** in the style of Alpha Progression. No clutter: calories, protein, carbs and fat only.
- **Store raw, compute later.** Save exactly what happened (weight, reps, RIR, timestamps, the bodyweight at that time). Estimates like e1RM and maintenance are always derived from that data, never stored as the only copy.
- **Every record is timestamped**, so later analysis can line anything up against anything else (supplement → weight trend, sleep → strength, and so on).
- **Every feature can be turned off** in Settings: whole modules (gym, food, supplements, AI) and smaller features (rest timer, RPE/RIR column, warm-up sets, post-workout survey, carb/fat targets, reminders). Turned-off features vanish from the UI completely. The app is only as busy as the user makes it.
- **Every calculation is based on published science.** e1RM, 10RM, drop-set weights, rest defaults, maintenance, BMR, and anything added later. Each formula is cited in the code and in "Science sources" below. Before implementing a formula, check the citation is real and says what we claim. If no solid literature exists, label the number in the UI as a rough guide.
- **Works on desktop too.** The same app is responsive. The phone is for logging, and a PC browser is nice for looking at history and analytics. Wider screens get multi-column layouts.
- **Units:** kg by default, with a setting for kg/lb. Weights are always stored in kg along with the unit they were entered in, so switching units never changes the data.

## Global

- **Profile:** sex, birth year, height, units (kg/lb, cm/in), and activity level (used only for the first maintenance estimate).
- **Bodyweight log:** date, time, weight. The reminder interval is configurable (default weekly) and sent as a server push. The latest weight is available to the whole app.
- **Progress photos:** dropped for now (2026-11-16). May come back later; nothing in the app or data model depends on them.
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
- **Effort:** you can enter RPE or RIR. The set stores the value as entered (`effortInput` says which scale); the other scale is derived only where the RIR-based RPE scale (Zourdos 2016) gives one value: RPE 7–10 ↔ RIR 3–0 (RPE 9.5 = 0 RIR: no more reps, a little more load), RPE 5–6 = the 4–6 RIR band (→ 5), RPE < 5 has no RIR, RIR ≥ 4 has no single RPE (derived field null, the cell shows the entered value with its scale, e.g. "4 RIR"). Never a plain 10 − x. Half steps are allowed. Effort is optional.
- **e1RM column** (Settings → Workout → e1RM column, on by default): per working set, the e1RM of the typed values (or greyed from the suggestion), live as weight/reps/RIR change. ≥ = no RIR logged (reps alone, a lower bound); ≈ = more than 12 reps to failure; a soft green cell = above every earlier session's best reliable e1RM by the PR margin (`sessions.liveProgress.priorBestE1rm`). Hidden for warm-ups, drop steps, and bodyweight/assisted lifts without a known bodyweight. The same value is in `sessions.get` / `progress.exercise` set output (`e1rm`) and the exercise history set lines.
- Finishing saves the duration. Sessions can be edited afterwards.

**Analytics page (later):** per exercise or overall. History, e1RM/10RM trends, volume, bodyweight, and so on. On desktop it gets more room.

**Later (not v1):** e1RM and 10RM progression charts and achievements. (PRs and beat-last-time are shown on the workout summary, see below.)
- e1RM comes from reps + RIR (reps-to-failure = reps + RIR) through the Wathen equation (`e1rm` / `setE1rm` in `src/lib/science.ts`, the one function every feature uses). 10RM is derived from e1RM (`nRepMax`).
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

**Adaptive maintenance** (built 2026-11-16, `maintenance.estimate` / `maintenance.apply`, `src/lib/maintenance.ts`; feature switch "Adaptive maintenance", on by default)
- **Computed on read** from raw facts (food entries, day status, weigh-ins); nothing derived is stored except the maintenance value saved into a goal version when the user saves Goals.
- **Window:** the 28 days ending today (14–42 selectable via the command).
- **Intake noise rules:**
  - Only days marked "fully logged" count. A missing or unmarked day is never 0 kcal; it's left out.
  - A complete day under 800 kcal ("likely not fully logged") or over 2.5 × the formula estimate ("absurd") is excluded.
  - Then a robust outlier rule on the rest (≥ 7 days): modified z-score |x − median| / (1.4826·MAD) > 3.5 (Iglewicz & Hoaglin), with the scale floored at 20% of the median so a very regular eater isn't flagged. 3.5 is deliberately loose, because dropping real big-eating days biases maintenance low. A known bias remains: a genuine feast day more than ~3.5 robust SDs above your usual intake (> 70% above the median for a very regular eater) is still left out, and it shows in the "Days left out" list.
  - Every excluded day is returned with its reason and listed in the "how" sheet.
- **Weight noise rules:** one value per day (median of that day's weigh-ins). Outside 25–350 kg = typo. More than max(2 kg, 3%) from the median of weigh-ins within ±7 days (needs ≥ 2 neighbours) = likely mistake (our own rule). Cleaning happens before any smoothing or fitting. The formula estimate also uses the latest clean weigh-in, so a typo can't wreck it.
- **Trend:** Theil–Sen line (median of pairwise slopes) through the clean weigh-ins in the window. It's robust to leftover water spikes, handles gaps, and has no EWMA lag. Trend start/end and kg/week come from this line. An EWMA (10%/day, Hacker's Diet style; a weigh-in after a g-day gap gets weight 1 − 0.9^g) is returned per day for the agent. It isn't drawn, because in a steady trend it lags and looks wrong.
- **Estimate:** data TDEE = mean intake on used days − slope (kg/day) × 7700 kcal/kg. It needs ≥ 10 used intake days and ≥ 5 clean weigh-ins spanning ≥ 10 days; otherwise the formula is used and `needs` says what's missing.
- **Shrinkage toward the formula** (precision weighting, normal–normal): w = τ² / (τ² + SE²), SE² = SD(intake)²/n + (7700·SE(slope))², SE(slope) from the residual scatter around the line (floored at 0.3 kg), τ = 15% of the formula estimate (our convention). Source: `formula` (no data or feature off), `blended` (w < 0.75), `adaptive` (w ≥ 0.75). Confidence from SE: high ≤ 150, medium ≤ 300 kcal, else low.
- **Stability:** the estimate is replayed day by day over the last 56 days and moves at most 75 kcal/day (≈ 500/week, after rounding to 10). When the data thins out it eases back toward the formula at the same rate, never in one jump; source stays "blended" until it gets there.
- **Manual override wins:** a goal with maintenanceSource "manual" keeps its number; the sheet still shows what the logs say.
- **Calorie target:** the Goals page computes maintenance = override ?? log-based ?? formula and derives the target from it. The stored target (read by Food/Home) changes only when the user saves Goals. Until then the new target is shown as a suggestion ("New · was …"). Saving stores maintenanceKcal with source "adaptive". `maintenance.apply` lets the agent accept the estimate (and reset the target) directly.
- **UI:** the Goals maintenance card shows the source ("From your logs · 21 days", "Logs + formula · 9 days", "Formula estimate", "Set by you"), ± range, and a "Rough guide" tag. The "how" sheet shows the weigh-ins with the trend line (ignored weigh-ins as red rings), the arithmetic, the days left out, and the ignored weigh-ins.

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
exercises(name, load_type, bw_fraction?, muscles[], equipment, custom)
plans(name, workout_ids[] ordered)
exercises += (mechanic: compound|isolation, unilateral: bool, image)
workouts(plan_id, name, items[{exercise_id, order, superset_group?, target_sets, target_reps?,
         rest: {mode: timer|countup, seconds?}, drop_steps?, notes}])
sessions(workout_id?, started_at, ended_at, notes, structure_snapshot,   // its own editable copy of items
         session_rpe?, sleep?: bad|ok|good, soreness?: fresh|normal|beat, rated_at?)   // post-workout survey, optional
sets(session_id, exercise_id, set_no, side: both|left|right, kind: warmup|working|drop,
     parent_set_id?,  // drop steps point at their main set
     load_kg?, load_type,  // weighted: the weight; bodyweight: added weight; assisted: assistance
     input_unit: kg|lb,
     bodyweight_kg_snapshot, reps, rpe?, rir?, effort_input: rpe|rir, done_at)
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

## Workout summary and post-workout survey (built 2026-11-16)

Replaces the planned daily check-in: the survey is asked once, right after a workout, where the user already is.

- **Summary** (`sessions.summary`, shown as a full-screen sheet after Finish and from any past session's header): duration, working sets, volume load; PR and beat-last-time highlights first; each exercise with best set, e1RM and ↑ / = / ↓ / New against the previous session of that exercise; working sets per muscle (today and this week since Monday) as bars; comparison with the last session of the same plan workout (volume %, minutes, sets).
- Comparisons only use sessions that started before this one, so a past summary never changes because of later workouts.
- **Definitions** (all computed on read from raw sets, `src/lib/workoutStats.ts`):
  - *Working set* = one per exercise slot and set number: a left + right pair is one set, drop steps fold into their parent set, warm-ups never count.
  - *Volume load* = Σ load × reps over working sets **and drop steps** (drops are real work), warm-ups excluded, both sides of one-side sets counted. Load is the total load moved: bodyweight snapshot + added weight for bodyweight lifts, bodyweight − assistance for assisted ones (a weigh-in near the session is used if a set has no snapshot). Dumbbell loads are as logged (per dumbbell).
  - *Best set* = the working set with the highest e1RM (drops excluded).
  - *Beat last time* = higher best e1RM than the previous session of that exercise, or more reps at ≥ last time's top weight (the reps rule also works when e1RM can't be estimated). The ↑ arrow shows beat-last-time or any all-time PR. For bodyweight/assisted lifts the e1RM must move by more than 1%, so bodyweight drift alone doesn't count (our own tolerance).
  - *PRs* (against every earlier session; never on the first time an exercise is done): e1RM PR (reliable estimates only, ≤ 12 reps to failure), weight PR (heaviest logged load; for bodyweight lifts the added weight, for assisted the least assistance), rep PR (more reps than ever at that load or heavier).
  - *Sets per muscle*: 1 per working set for each primary muscle; secondary muscles count 0.5 in the "fractional" total (a convention, labelled as such in the UI).
  - *Improvements* (the big badge): PR sets + sets that beat the same set last time, per set with the live screen's rules (`sessions.liveProgress` badges); each exercise row shows its own PR-set and ↑-set counts, which add up to the badge.
  - *Nth workout* = 1 + finished workouts that started before this one. *Week streak* = Monday-start weeks in a row with a workout, counting back from this session's week. Both are as of the session, so a past summary never changes. `sessions.streak` gives the current streak (a week with no workout yet doesn't break it until it's over).
- **Layout (2026-11-16, modelled on docs/design-refs/alpha-workout-summary.png):** badge, stat strip (Nth workout · duration · streak), a quiet line with sets · volume · % vs last time, exercise rows (tap for best set, est. 1RM, records), sort by workout order / most improved, muscle rows (share % · sets · this week), then the survey.
- **Survey** (`sessions.rate`, feature switch "Post-workout survey", on by default): one tap each, all skippable, saved as you tap:
  1. Effort: session RPE on the CR-10 scale, 0–10 (Foster et al. 2001). Different from the per-set RIR-based RPE.
  2. Sleep last night: bad / ok / good.
  3. Body: fresh / normal / beat up.
  4. Optional note (stored as the session notes).
  Stored as raw optional fields on the session, with `ratedAt`. The summary also returns session load = session RPE × minutes (Foster's training load), so an agent can line effort, sleep and soreness up against performance later.

## Progression targets and live progress (built 2026-11-16)

- **Progression target** (`exercises.nextTarget`, feature switch "Progression suggestions", on by default): the greyed numbers in the live workout's working-set rows are today's target instead of last time's, and a bare ✓ saves them. A small hint on the exercise header (`↑ +2.5 kg`, `+1 rep`, `= hold`, `↓ −2.5 kg`) opens a sheet with the reason and last time → today per set, labelled a rough guide. Off: last time's numbers, as before.
- **Rule** (`progressionTarget` in `src/lib/science.ts`): double progression with an RIR brake, based on the last *finished* session (started before this one) with done working sets of the exercise, and the slot's rep range lo–hi (only lo → fixed reps):
  1. Every working set (both sides of one-side lifts) at ≥ hi reps with RIR ≥ 1 or no RIR logged → **increase**: + one equipment step (`stepKg`, kg/lb-snapped; assisted = one step less assistance, never below 0), reps = lo. Bodyweight lifts with no added weight (or assisted with none left) → +1 rep instead.
  2. More than half the sets below lo → **reduce**: one step lighter, reps = lo (hold if there is no load to take off).
  3. Otherwise **reps**: same load; each set below lo → lo, at/over hi → hi, else +1 rep, but a set at RIR 0 repeats its reps. Nothing changes → **hold**.
  Mixed weights (pyramids/back-offs) keep their shape: the same step is added to each set's own load. Extra sets beyond last time's count carry the row above. Warm-ups keep last time's numbers; drop steps are still computed from their parent set. No rep range or no history → no rule (last time's numbers). Effort: last time's RIR is greyed (and saved by a bare ✓) only on rows whose load and reps are both unchanged, so an invented effort never raises e1RM.
- **Live progress** (`sessions.liveProgress`): the live header shows timer · working sets done / planned · volume (same counting as the summary). A ticked working set gets a badge: **PR** (all-time e1RM / weight / rep record by the summary's rules; today's earlier-ticked sets count as prior, so only the set that raised the bar gets it; never on an exercise's first time) or **↑** (beat the same set number + side of the previous session: higher e1RM or more reps at ≥ its weight). The badge pops in (spring, no bounce; opacity only with reduced motion), with a 10 ms vibration where supported (not iOS). When the last set of an exercise moves the screen on to the next exercise, the badge is already there when you come back (no pop). Computed on read, nothing stored.

## Decisions (2026-11-15)

- **Hosting:** probably Cloudflare Pages, since the repo is private. To be decided when deploying.
- **Rest timer:** yes, with defaults by mechanic, set per exercise, or count-up.
- **Daily check-ins:** replaced by the post-workout survey (2026-11-16). Every feature can be turned off.
- **Progress photos** and **device management:** dropped for now (2026-11-16).
- **Units:** kg by default, lb available in settings and from the weight wheel.
- **History import:** none in the app. The user will export from Alpha Progression and MyNetDiary later, and we import it once by script.
- **UI reference:** Alpha Progression's active workout screen, as described above.

## Science sources

Every formula in the code links back here. **Verify each source before implementing** (rows below verified 2026-11-15 against PubMed/journal records; the BMR, weight-trend and maintenance rows are verified when food is built) (it must be real, and the claim must match). Add a new row whenever a calculation is added.

| Calculation | Approach | Source |
|---|---|---|
| Effort scale | RIR-based RPE table: RPE 10/9.5 = 0 RIR, 9 = 1, 8.5 = 1–2, 8 = 2, 7.5 = 2–3, 7 = 3, 5–6 = 4–6 band, ≤ 4 not defined in RIR. Store the entered scale; derive the other only where one-to-one (not a plain 10 − x). Half steps allowed | Zourdos et al. 2016, *JSCR*, "Novel resistance training–specific RPE scale measuring repetitions in reserve"; Helms et al. 2016, *Strength Cond J* |
| e1RM | Reps to failure = reps + RIR, then Wathen: 1RM = w / (0.488 + 0.538·e^(−0.075·r)); r ≤ 1 → w, 1 < r < 2 blended linearly to r = 2. No RIR logged → reps alone = lower bound (≥). > 12 reps to failure → ≈ and excluded from e1RM PRs / analysis. **Verified** (equation form: Mayhew et al. 2008 Table 2; Reynolds 2006 abstract: ≤ 10 reps for linear equations, non-linear ones used to ~15). | Wathen 1994, *Essentials of S&C* pp. 435–439; LeSuer et al. 1997, *JSCR* 11(4):211–213 (Mayhew & Wathen accurate for bench, only Wathen for squat; all under-predict deadlift ~9–14 %); Reynolds, Gordon & Robergs 2006, *JSCR* 20(3):584–592; Mayhew et al. 2008, *JSCR* 22(5):1570–1577; RIR method: Zourdos et al. 2016, Helms et al. 2016 |
| 10RM / nRM | Invert the same formula from e1RM | As above |
| Drop-set weight | Drop by 20% per step (the literature typically uses 20–25%), rounded to the nearest weight the equipment allows | Coleman et al. 2023, *Sports Med Open*, "Effects of Drop Sets on Skeletal Muscle Hypertrophy" (PMC10390395); background: Schoenfeld & Grgic 2018, *Strength Cond J* 40(6):95–98 |
| Rest defaults | Compound 3 min, isolation 1.5 min (the user's choice). Longer rest supports strength and hypertrophy on compound lifts. | Schoenfeld et al. 2016, *JSCR* (1 vs 3 min rest) |
| BMR | Mifflin-St Jeor: 10·kg + 6.25·cm − 5·age + 5 (male) / −161 (female). **Verified.** | Mifflin et al. 1990, *Am J Clin Nutr* 51(2):241–247 |
| Activity multiplier (PAL) | Mostly sitting 1.40, light 1.55, active 1.85, very active 2.20 (the lower bound / midpoints of FAO's categories). Starting estimate only. **Verified.** | FAO/WHO/UNU 2004, *Human energy requirements*, Table 5.3 (sedentary/light 1.40–1.69, active 1.70–1.99, vigorous 2.00–2.40) |
| Protein default | 1.6 g/kg/day; the user can change it. **Verified.** | Morton et al. 2018, *Br J Sports Med* 52(6):376–384 (no further FFM gains above ~1.62 g/kg/day) |
| Quick-add calories from macros | 4 kcal/g protein, 4 kcal/g carbohydrate, 9 kcal/g fat (Atwater general factors), used only when kcal is left blank | Atwater general factors, as used in USDA food composition data |
| Before/after comparison (agent analysis) | Welch's unequal-variances t-test, two-sided; df by Welch–Satterthwaite; p via regularized incomplete beta (Numerical Recipes §6.4). e1RM pooled across lifts as ratio to each lift's mean; estimates >12 reps to failure excluded | Welch 1947, *Biometrika* 34(1–2):28–35; Reynolds et al. 2006 (exclusion) |
| Session RPE / session load | Whole-session effort on the modified CR-10 scale (0–10), asked after the workout; session load = sRPE × duration in minutes (arbitrary units). **Verified.** | Foster et al. 2001, *J Strength Cond Res* 15(1):109–115, "A new approach to monitoring exercise training" |
| Volume load | Σ load × reps of working sets and drop steps, warm-ups excluded; total load as in e1RM (bodyweight + added, bodyweight − assistance) | Standard definition of volume load (sets × reps × load); no single formula paper |
| Sets per muscle | Working sets per muscle (direct = primary muscles), per session and per week. Secondary muscles at 0.5 is a **convention** (fractional counting, as proposed in Pelland et al., SportRxiv preprint), labelled as such in the UI. **Verified** (Schoenfeld). | Schoenfeld, Ogborn & Krieger 2017, *J Sports Sci* 35(11):1073–1082 (weekly sets per muscle, dose-response) |
| Beat last time / PRs | Higher e1RM or more reps at ≥ the previous top weight; e1RM PRs only from ≤ 12 reps to failure; 1% margin for bodyweight/assisted e1RM. Our own definitions. | Reynolds et al. 2006 (reliability cut-off); otherwise — (labelled as our own rule) |
| Progression target | Double progression: all working sets at the top of the rep range with RIR ≥ 1 → + one equipment step, back to the bottom; most sets below the range → − one step; otherwise +1 rep per set (sets at RIR 0 repeat). A **coaching convention** (as in Alpha Progression and similar apps), labelled a rough guide in the UI; no study validates these thresholds. RIR read on the RIR-based RPE scale. | Convention. Effort scale: Zourdos et al. 2016; Helms et al. 2016. Background only (RIR-autoregulated vs fixed loading studied, not this rule): Graham & Cleather 2021, *JSCR* 35(9):2451–2456 (existence and design verified; result not checked) |
| Goal hit (calendar dot) | Calories within ±10% of target and protein ≥ 95% of target. Our own tolerance, not a published standard. | — (labelled as a rough guide) |
| Weight trend (display) | EWMA of clean daily weigh-ins, 10% per day, gaps weighted 1 − 0.9^g. A **convention**. | Walker, *The Hacker's Diet* (method); not peer-reviewed |
| Weight trend (estimate) | Theil–Sen robust line: median of pairwise slopes, intercept = median(y − b·t). **Verified** (bibliographic record and method). | Sen 1968, *JASA* 63(324):1379–1389, "Estimates of the regression coefficient based on Kendall's tau"; Theil 1950 (not checked) |
| Intake outliers | Modified z-score > 3.5 with MAD (×1.4826) flagged as outlier. **Verified** via the NIST handbook, which attributes the 3.5 cut-off to Iglewicz & Hoaglin. Background: Leys et al. 2013 argue for MAD over mean ± SD (they suggest 2.5; we use the looser 3.5 so real high days stay in). | Iglewicz & Hoaglin 1993, *How to Detect and Handle Outliers* (ASQC), as given in NIST/SEMATECH e-Handbook §1.3.5.17; Leys et al. 2013, *J Exp Soc Psychol* 49(4):764–766 |
| Intake / weight plausibility | < 800 kcal, > 2.5 × formula, weigh-in outside 25–350 kg, or > max(2 kg, 3%) from nearby weigh-ins. Our own thresholds, labelled a rough guide. | — (our own rules) |
| Adaptive maintenance | TDEE ≈ mean intake on fully logged days − trend slope × 7700 kcal/kg. **Verified (abstract):** Hall shows the 3500 kcal/lb (≈ 32.2 MJ/kg ≈ 7700 kcal/kg) rule roughly fits people with > ~30 kg body fat and **overstates** the energy per kg for leaner people. The "early weight change is water and glycogen, so it's less energy-dense" caveat in the UI is general physiology. Hall's reference list includes glycogen–water storage papers, but we couldn't read the full text, so it isn't attributed to him. | Hall 2008, *Int J Obes* 32(3):573–576, "What is the required energy deficit per unit weight loss?" (PMID 17848938) |
| Blending with the formula | Precision-weighted (normal–normal) shrinkage, τ = 15% of the formula estimate. The formula's spread is a **convention**: Mifflin-St Jeor is within ±10% of measured RMR for more adults than other equations, but individual errors remain, and PAL adds more. 75 kcal/day cap is our convention. | Standard Bayesian normal–normal update (textbook result, e.g. Gelman et al., *Bayesian Data Analysis*; chapter not checked); Frankenfield, Roth-Yousey & Compher 2005, *J Am Diet Assoc* 105(5):775–789 (RMR, background only) |
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

## Programmatic interface (agent-ready)

Every action and query is a command in `src/api` (registry + gym, food, body, analysis): zod input schema, LLM-readable description, kind query|action. `window.tapin.call(name, input)`, `listCommands()`, `toolDefinitions()` (JSON Schema, ready for tool-use). New features add commands first; UI should call commands rather than write to the database directly (migration of older UI code is ongoing).
