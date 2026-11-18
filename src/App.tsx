import { MotionConfig, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useLocation } from 'react-router';
import { DialogHost } from './components/Dialog';
import { ToastHost } from './components/Toast';
import { Icon } from './components/Icon';
import { seedIfNeeded } from './db/seed';
import { startSync } from './lib/sync';
import { useSettings } from './db/settings';
import { ExerciseHistoryPage, HistoryPage } from './pages/History';
import { HomePage } from './pages/Home';
import { AllPlansPage, PlanPage, PlansPage } from './pages/Plans';
import { SessionPage } from './pages/Session';
import { SettingsPage } from './pages/Settings';
import { WeightPage } from './pages/Weight';
import { WorkoutEditorPage } from './pages/WorkoutEditor';
import { FoodPage } from './pages/Food';
import { NutritionPage } from './pages/Nutrition';
import { SupplementsPage } from './pages/Supplements';
import { StatsPage } from './pages/Stats';
import { ExercisesPage } from './pages/Exercises';
import { CalendarPage } from './pages/Calendar';
import { AgentChatPage, AgentFab, AgentMemoryPage, AgentNewPage, AgentPage, QuickChatHost } from './pages/Agent';
import { purgeChats } from './lib/agent/chats';
import { JournalPage } from './pages/Journal';

function Fab() {
  const s = useSettings();
  return <AgentFab hidden={s.features.agent === false} />;
}

type Tab = { to: string; icon: string; label: string; home?: boolean };

/** Floating glass capsule; Home sits in the middle as the raised button.
 *  A shared-layout bubble slides between tabs (spring, no overshoot). */
function TabBar() {
  const { pathname } = useLocation();
  const s = useSettings();
  if (pathname.startsWith('/session/') || /^\/agent\/(?!memory$)./.test(pathname)) return null; // the chat has its own composer at the bottom
  const left: Tab[] = [
    ...(s.features.gym ? [{ to: '/plans', icon: 'dumbbell', label: 'Gym' }] : []),
    ...(s.features.food ? [{ to: '/food', icon: 'food', label: 'Food' }] : []),
  ];
  const right: Tab[] = [
    s.features.supplements ? { to: '/supps', icon: 'pill', label: 'Supps' } : { to: '/weight', icon: 'scale', label: 'Weight' },
    { to: '/settings', icon: 'settings', label: 'Settings' },
  ];
  const tabs: Tab[] = [...left, { to: '/', icon: 'home', label: 'Home', home: true }, ...right];
  const isActive = (t: Tab) => (t.home ? pathname === '/' : pathname.startsWith(t.to)
    || (t.to === '/plans' && /^\/(workouts|history|exercise|stats)/.test(pathname)) || (t.to === '/food' && pathname.startsWith('/nutrition')));
  return (
    <div className="tabbar">
      <nav aria-label="Main">
        {tabs.map((t) => {
          const on = isActive(t);
          return (
            <NavLink key={t.to} to={t.to} end={t.home} aria-label={t.label} className={(on ? 'active' : '') + (t.home ? ' home' : '')}>
              {on && !t.home && <motion.span layoutId="tab-bubble" className="tab-bubble" transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }} />}
              {t.home ? <span className="tab-home"><Icon name="home" size={24} stroke={2.1} /></span> : <Icon name={t.icon} size={24} stroke={on ? 2.2 : 1.8} />}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}

const TITLES: [string, string][] = [ // longest prefix first
  ['/plans/all', 'Plans'], ['/plans/', 'Plan'], ['/plans', 'Gym'], ['/workouts/', 'Workout'], ['/session/', 'Workout'], ['/history', 'History'],
  ['/exercises', 'Exercises'], ['/exercise/', 'Exercise'], ['/stats', 'Stats'], ['/weight', 'Weight'], ['/settings', 'Settings'],
  ['/food', 'Food'], ['/nutrition', 'Goals'], ['/supps', 'Supps'], ['/calendar', 'Calendar'], ['/agent', 'Agent'], ['/journal', 'Journal'],
];

/** .app is the scroll container (see index.css), so reset it to the top on every route change.
 *  Client-side routes also reset nothing for assistive tech: set the tab title and move focus to the new page's heading. */
function ScrollReset() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    document.querySelector('.app')?.scrollTo(0, 0);
    document.title = `${TITLES.find(([p]) => pathname.startsWith(p))?.[1] ?? 'Today'} · Tap In`;
    if (first.current) { first.current = false; return; }
    const raf = requestAnimationFrame(() => {
      const h = document.querySelector<HTMLElement>('main h1');
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [pathname]);
  return null;
}

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    seedIfNeeded().finally(() => { setReady(true); void startSync(); void purgeChats(); });
    navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our data
  }, []);
  if (!ready) return <div className="app" />;
  return (
    <MotionConfig reducedMotion="user">
    <HashRouter>
      {/* .shell is the full-screen frame; bars live in it (absolute), not in the page and not position:fixed,
          because iOS standalone mis-places fixed bars (WebKit bug 237961). .app is the only scroller. */}
      <div className="shell">
      <div className="app">
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/plans/all" element={<AllPlansPage />} />
          <Route path="/plans/:id" element={<PlanPage />} />
          <Route path="/workouts/:id" element={<WorkoutEditorPage />} />
          <Route path="/session/:id" element={<SessionPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/exercise/:id" element={<ExerciseHistoryPage />} />
          <Route path="/exercises" element={<ExercisesPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/weight" element={<WeightPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/food" element={<FoodPage />} />
          <Route path="/nutrition" element={<NutritionPage />} />
          <Route path="/supps" element={<SupplementsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/journal" element={<JournalPage />} />
          <Route path="/agent" element={<AgentPage />} />
          <Route path="/agent/new" element={<AgentNewPage />} />
          <Route path="/agent/memory" element={<AgentMemoryPage />} />
          <Route path="/agent/:id" element={<AgentChatPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
        </main>
        <ScrollReset />
      </div>
      <TabBar />
      <Fab />
      <QuickChatHost />
      <DialogHost />
      <ToastHost />
      </div>
    </HashRouter>
    </MotionConfig>
  );
}
