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
import { BlindReceiptScreen } from '../features/stock/BlindReceiptScreen.js';
import { ConsumptionScreen } from '../features/stock/ConsumptionScreen.js';
import { CashSessionScreen } from '../features/cash/CashSessionScreen.js';
import { ReplenishScreen } from '../features/distribution/ReplenishScreen.js';
import { DistributionScreen } from '../features/distribution/DistributionScreen.js';
import { PosHomeScreen } from '../features/distribution/PosHomeScreen.js';
import { CountScreen } from '../features/stock/CountScreen.js';
import { TransferScreen } from '../features/stock/TransferScreen.js';
import { CustomerScreen } from '../features/crm/CustomerScreen.js';
import { InteractionScreen } from '../features/crm/InteractionScreen.js';
import { NewProspectScreen } from '../features/crm/NewProspectScreen.js';
import { NewVisitScreen } from '../features/crm/NewVisitScreen.js';
import { PerformanceScreen } from '../features/crm/PerformanceScreen.js';
import { ServiceScreen } from '../features/fieldwork/ServiceScreen.js';
import { PriceRulesScreen } from '../features/pricing/PriceRulesScreen.js';
import { CatalogScreen } from '../features/catalog/CatalogScreen.js';
import { LedgerScreen } from '../features/stock/LedgerScreen.js';
import { OutputScreen } from '../features/production/OutputScreen.js';
import { LotSetupScreen } from '../features/production/LotSetupScreen.js';
import { IncubationScreen } from '../features/production/IncubationScreen.js';
import { LotSheetScreen } from '../features/production/LotSheetScreen.js';
import { TargetsScreen } from '../features/crm/TargetsScreen.js';
import { SuppliersScreen } from '../features/procurement/SuppliersScreen.js';
import { OrdersScreen as PurchaseOrdersScreen } from '../features/procurement/OrdersScreen.js';
import { PriceSimulatorScreen } from '../features/pricing/PriceSimulatorScreen.js';
import { ReceiptScreen } from '../features/procurement/ReceiptScreen.js';
import { RequestScreen } from '../features/procurement/RequestScreen.js';
import { DailyEntryScreen } from '../features/production/DailyEntryScreen.js';
import { EggCollectionScreen } from '../features/production/EggCollectionScreen.js';
import { LotsScreen } from '../features/production/LotsScreen.js';
import { PortfolioScreen } from '../features/crm/PortfolioScreen.js';
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
            {/* Clés distinctes : l'écran de résultat ne survit pas au retour à la liste. */}
            <Route path={ROUTES.receive} element={<ReceiveTransferScreen key="liste" />} />
            <Route path={ROUTES.receivePattern} element={<ReceiveTransferScreen key="detail" />} />
            <Route path={ROUTES.portfolio} element={<PortfolioScreen />} />
            <Route path={ROUTES.count} element={<CountScreen />} />
            <Route path={ROUTES.blindReceipt} element={<BlindReceiptScreen />} />
            <Route path={ROUTES.consumption} element={<ConsumptionScreen />} />
            <Route path={ROUTES.cash} element={<CashSessionScreen />} />
            <Route path={ROUTES.replenish} element={<ReplenishScreen />} />
            <Route path={ROUTES.distribution} element={<DistributionScreen />} />
            <Route path={ROUTES.posHome} element={<PosHomeScreen />} />
            <Route path={ROUTES.transfer} element={<TransferScreen key="liste" />} />
            <Route path={ROUTES.transferPattern} element={<TransferScreen key="detail" />} />
            <Route path={ROUTES.newProspect} element={<NewProspectScreen />} />
            <Route path={ROUTES.newVisit} element={<NewVisitScreen />} />
            <Route path={ROUTES.performance} element={<PerformanceScreen />} />
            <Route path={ROUTES.service} element={<ServiceScreen />} />
            <Route path={ROUTES.priceSimulator} element={<PriceSimulatorScreen />} />
            <Route path={ROUTES.priceRules} element={<PriceRulesScreen />} />
            <Route path={ROUTES.catalog} element={<CatalogScreen />} />
            <Route path={ROUTES.stockLedger} element={<LedgerScreen />} />
            <Route path={ROUTES.productionOutput} element={<OutputScreen />} />
            <Route path={ROUTES.lotSetup} element={<LotSetupScreen />} />
            <Route path={ROUTES.incubation} element={<IncubationScreen />} />
            <Route path={ROUTES.lotSheet} element={<LotSheetScreen />} />
            <Route path={ROUTES.targets} element={<TargetsScreen />} />
            <Route path={ROUTES.suppliers} element={<SuppliersScreen />} />
            <Route path={ROUTES.purchaseOrders} element={<PurchaseOrdersScreen />} />
            <Route path={ROUTES.productionLots} element={<LotsScreen />} />
            <Route path={ROUTES.dailyEntryPattern} element={<DailyEntryScreen />} />
            <Route path={ROUTES.eggCollection} element={<EggCollectionScreen />} />
            <Route path={ROUTES.purchaseRequests} element={<RequestScreen />} />
            <Route path={ROUTES.purchaseReceipts} element={<ReceiptScreen key="liste" />} />
            <Route path={ROUTES.purchaseReceiptPattern} element={<ReceiptScreen key="detail" />} />
            <Route path={ROUTES.customerPattern} element={<CustomerScreen />} />
            <Route path={ROUTES.interactionPattern} element={<InteractionScreen />} />
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
