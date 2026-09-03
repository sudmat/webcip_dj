import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ProcessingApp } from './workspaces/ProcessingApp';
import { DisplayApp } from './workspaces/DisplayApp';
import { ErrorBoundary } from './layout/ErrorBoundary';
import { THEMES, useTheme } from './core/theme';

// Router shell: the Processing viewer (/viewer) and the Result-display app (/display) share
// the same scene modules (ReslicePane, View3D, ViewerController).
export default function App() {
  const [theme, setTheme] = useTheme();
  return (
    <HashRouter>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <nav
          style={{
            display: 'flex',
            gap: 4,
            alignItems: 'center',
            padding: '6px 12px',
            borderBottom: '1px solid var(--panel-border)',
            background: 'var(--panel-alt)',
          }}
        >
          <strong style={{ marginRight: 12 }}>WebCIP</strong>
          <Tab to="/viewer">Viewer</Tab>
          <Tab to="/display">Display</Tab>
          <div style={{ flex: 1 }} />
          <ThemePicker theme={theme} setTheme={setTheme} />
        </nav>
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* A render throw below would otherwise unmount everything and leave a blank page. */}
          <ErrorBoundary>
          <Routes>
            <Route path="/viewer" element={<ProcessingApp />} />
            <Route path="/display" element={<DisplayApp />} />
            <Route path="*" element={<Navigate to="/viewer" replace />} />
          </Routes>
          </ErrorBoundary>
        </div>
      </div>
    </HashRouter>
  );
}

function ThemePicker({ theme, setTheme }: { theme: string; setTheme: (id: string) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
      Theme
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value)}
        title={THEMES.find((t) => t.id === theme)?.hint}
        style={{ background: 'var(--control-bg)', padding: '2px 4px' }}
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id} title={t.hint}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        padding: '3px 12px',
        borderRadius: 4,
        textDecoration: 'none',
        color: isActive ? 'var(--accent-text)' : 'var(--muted)',
        background: isActive ? 'var(--accent)' : 'transparent',
        fontWeight: isActive ? 700 : 400,
      })}
    >
      {children}
    </NavLink>
  );
}
