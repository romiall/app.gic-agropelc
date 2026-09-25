/**
 * Coquille de l'application : bascule entre les écrans d'authentification (ECR-ADM-01, 02)
 * et l'application déverrouillée (accueil + synchronisation), et pilote le démarrage/arrêt du
 * moteur de synchronisation avec le cycle de vie de la session.
 */
import { useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from '../features/auth/AuthContext.js';
import { LoginScreen } from '../features/auth/LoginScreen.js';
import { PinSetupScreen } from '../features/auth/PinSetupScreen.js';
import { PinUnlockScreen } from '../features/auth/PinUnlockScreen.js';
import { HomeScreen } from '../features/home/HomeScreen.js';
import { SyncBadge } from '../features/sync/SyncBadge.js';
import { SyncScreen } from '../features/sync/SyncScreen.js';
import { startSyncEngine, stopSyncEngine } from '../features/sync/sync-engine-instance.js';
import { countPending } from '../sync/outbox.js';
import { getDb } from '../storage/db.js';

function AppShell() {
  const { t } = useTranslation();
  const { state, deviceId, logout } = useAuth();

  useEffect(() => {
    if (state.status !== 'unlocked' || !deviceId) return;
    startSyncEngine(deviceId, () => void logout());
    return () => stopSyncEngine();
  }, [state.status, deviceId, logout]);

  if (state.status === 'loading') return null;

  if (state.status === 'login_required') return <LoginScreen />;
  if (state.status === 'pin_setup_required') return <PinSetupScreen />;
  if (state.status === 'locked') return <PinUnlockScreen />;

  const onLogout = async () => {
    const pending = await countPending(getDb());
    const message =
      pending > 0 ? t('auth.logout_confirm_pending', { count: pending }) : t('auth.logout_confirm');
    if (window.confirm(message)) await logout();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" style={{ color: 'inherit', textDecoration: 'none', fontWeight: 700 }}>
          {t('app.name')}
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <SyncBadge />
          <button type="button" className="secondary" onClick={() => void onLogout()}>
            {t('auth.logout')}
          </button>
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/synchronisation" element={<SyncScreen />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}
