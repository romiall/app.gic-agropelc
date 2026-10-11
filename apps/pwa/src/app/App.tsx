/**
 * Coquille de l'application : bascule entre les écrans d'authentification (ECR-ADM-01, 02)
 * et l'application déverrouillée (accueil + synchronisation), et pilote le démarrage/arrêt du
 * moteur de synchronisation avec le cycle de vie de la session.
 */
import { useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from '../features/auth/AuthContext.js';
import { LoginScreen } from '../features/auth/LoginScreen.js';
import { PinSetupScreen } from '../features/auth/PinSetupScreen.js';
import { PinUnlockScreen } from '../features/auth/PinUnlockScreen.js';
import { HomeScreen } from '../features/home/HomeScreen.js';
import { MenuScreen } from '../features/navigation/MenuScreen.js';
import { CollectScreen } from '../features/sales/CollectScreen.js';
import { StockScreen } from '../features/stock/StockScreen.js';
import { LossScreen } from '../features/stock/LossScreen.js';
import { ReceiveTransferScreen } from '../features/stock/ReceiveTransferScreen.js';
import { NewProspectScreen } from '../features/crm/NewProspectScreen.js';
import { DeliverScreen } from '../features/sales/DeliverScreen.js';
import { NewOrderScreen } from '../features/sales/NewOrderScreen.js';
import { NewSaleScreen } from '../features/sales/NewSaleScreen.js';
import { OrderDetailScreen } from '../features/sales/OrderDetailScreen.js';
import { OrdersScreen } from '../features/sales/OrdersScreen.js';
import { SaleDetailScreen } from '../features/sales/SaleDetailScreen.js';
import { SalesListScreen } from '../features/sales/SalesListScreen.js';
import { SyncBadge } from '../features/sync/SyncBadge.js';
import { SyncScreen } from '../features/sync/SyncScreen.js';
import { startSyncEngine, stopSyncEngine } from '../features/sync/sync-engine-instance.js';
import { countPending } from '../sync/outbox.js';
import { getDb } from '../storage/db.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { ROUTES } from './screens.js';

function AppShell() {
  const { t } = useTranslation();
  const { state, deviceId, logout } = useAuth();
  const location = useLocation();

  const unlockedUserId = state.status === 'unlocked' ? state.userId : undefined;
  useEffect(() => {
    if (!unlockedUserId || !deviceId) return;
    startSyncEngine(deviceId, unlockedUserId, () => void logout());
    return () => stopSyncEngine();
  }, [unlockedUserId, deviceId, logout]);

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
        <nav className="app-header-nav" aria-label={t('nav.menu')}>
          <SyncBadge />
          <Link to={ROUTES.menu} className="app-header-link">
            {t('nav.menu')}
          </Link>
        </nav>
      </header>
      <main className="app-main">
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            <Route path={ROUTES.home} element={<HomeScreen />} />
            <Route path={ROUTES.menu} element={<MenuScreen onLogout={() => void onLogout()} />} />
            <Route path={ROUTES.sync} element={<SyncScreen />} />
            <Route path={ROUTES.newSale} element={<NewSaleScreen />} />
            <Route path={ROUTES.sales} element={<SalesListScreen />} />
            <Route path={ROUTES.salePattern} element={<SaleDetailScreen />} />
            <Route path={ROUTES.newOrder} element={<NewOrderScreen />} />
            <Route path={ROUTES.orders} element={<OrdersScreen />} />
            <Route path={ROUTES.orderPattern} element={<OrderDetailScreen />} />
            <Route path={ROUTES.deliverPattern} element={<DeliverScreen />} />
            <Route path={ROUTES.collect} element={<CollectScreen />} />
            <Route path={ROUTES.stock} element={<StockScreen />} />
            <Route path={ROUTES.loss} element={<LossScreen />} />
            <Route path={ROUTES.receive} element={<ReceiveTransferScreen />} />
            <Route path={ROUTES.receivePattern} element={<ReceiveTransferScreen />} />
            <Route path={ROUTES.newProspect} element={<NewProspectScreen />} />
          </Routes>
        </ErrorBoundary>
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
