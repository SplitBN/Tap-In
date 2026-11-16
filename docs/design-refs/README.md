# Design references

Screenshots the user sent of apps whose **look and feel** Tap In should match (dark, friendly, calm, big tap targets,
few words). Use them as the reference for spacing, sizes, hierarchy and interaction — not to copy branding, names or
artwork. Any subagent working on UI should look at these first.

| File | What to take from it |
|---|---|
| `alpha-weight-picker.png` | Number entry: slim centred value pills over most of the screen, current value in lighter grey, tap = set + close; keypad with the typed number large + caret and a ✓ key; extra controls behind "Options". (Implemented in `src/components/NumberPicker.tsx`.) |
| `alpha-gym-home.png` | Gym tab: week strip at the top, active plan as a large title with ⋯, workouts as rows with exercise-thumbnail pills, plain text links below (All plans, Exercises). Sparse, airy. |
| `alpha-workout-preview.png` | Workout preview sheet: big title + ⋯, plan · week, "6 exercises · 12 sets", one big Start button, muscle map, exercise list with image, name, equipment · sets×reps. |
| `alpha-live-exercise.png` | Live exercise: thumbnail strip, big exercise name + ⋯, equipment / rep target / note lines, warm-up chip, set table with large pill cells, a green ✓, last session card below, floating rest-timer button. |
| `alpha-exercise-menu.png` | Exercise action sheet: header with info, large paired tiles (sets / reps), grouped rows with icons (Dropsets, Supersets / Add note / Replace, Remove), text links at the bottom. |
| `alpha-workout-summary.png` | End-of-workout summary: one big celebratory badge with a number (e.g. improvements/PRs), a stat strip (Nth workout · duration · week streak) with coloured icons, exercise rows (thumbnail, name · equipment, "2 sets", medal-count for PRs, green ↑-count for improved sets), sort control ("Workout order"), then muscle rows (muscle icon, share % · sets). Close / Share in the header. |

More screenshots may be added; keep this table updated.
