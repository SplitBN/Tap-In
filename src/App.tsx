import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useLocation } from 'react-router';
import { Icon } from './components/Icon';
import { seedIfNeeded } from './db/seed';
import { useSettings } from './db/settings';
import { ExerciseHistoryPage, HistoryPage } from './pages/History';
import { HomePage } from './pages/Home';
import { PlanPage, PlansPage } from './pages/Plans';
import { SessionPage } from './pages/Session';
import { SettingsPage } from './pages/Settings';
import { WeightPage } from './pages/Weight';
import { WorkoutEditorPage } from './pages/WorkoutEditor';

function TabBar() {
  const { pathname } = useLocation();
  const s = useSettings();
  if (pathname.startsWith('/session/')) return null;
  const tabs = [
    { to: '/', icon: 'home', label: 'Today', end: true },
    s.features.gym && { to: '/plans', icon: 'dumbbell', label: 'Plans' },
    s.features.gym && { to: '/history', icon: 'history', label: 'History' },
    { to: '/weight', icon: 'scale', label: 'Weight' },
    { to: '/settings', icon: 'settings', label: 'Settings' },
  ].filter(Boolean) as { to: string; icon: string; label: string; end?: boolean }[];
  return (
    <div className="tabbar">
      <nav aria-label="Main">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name={t.icon} size={24} /><span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    seedIfNeeded().finally(() => setReady(true));
    navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our data
  }, []);
  if (!ready) return <div className="app" />;
  return (
    <HashRouter>
      <div className="app">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/plans/:id" element={<PlanPage />} />
          <Route path="/workouts/:id" element={<WorkoutEditorPage />} />
          <Route path="/session/:id" element={<SessionPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/exercise/:id" element={<ExerciseHistoryPage />} />
          <Route path="/weight" element={<WeightPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
        <TabBar />
      </div>
    </HashRouter>
  );
}
