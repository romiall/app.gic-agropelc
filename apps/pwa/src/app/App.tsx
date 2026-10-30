/**
 * Coquille de l'application : bascule entre les écrans d'authentification (ECR-ADM-01, 02)
 * et l'application déverrouillée (accueil + synchronisation), et pilote le démarrage/arrêt du
 * moteur de synchronisation avec le cycle de vie de la session.
 */
import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from '../features/auth/AuthContext.js';
import { LoginScreen } from '../features/auth/LoginScreen.js';
import { PinSetupScreen } from '../features/auth/PinSetupScreen.js';
import { PasswordChangeScreen } from '../features/auth/PasswordChangeScreen.js';
import { PinUnlockScreen } from '../features/auth/PinUnlockScreen.js';
import { HomeScreen } from '../features/home/HomeScreen.js';
import { MenuScreen } from '../features/navigation/MenuScreen.js';
import { Shell } from '../features/shell/Shell.js';
import { SyncScreen } from '../features/sync/SyncScreen.js';
import { startSyncEngine, stopSyncEngine } from '../features/sync/sync-engine-instance.js';
import { countPending } from '../sync/outbox.js';
import { pendingAttachments } from '../sync/attachment-upload.js';
import { getDb } from '../storage/db.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { ROUTES } from './screens.js';

// Écrans chargés à la demande (NFR-05 : JS initial ≤ 300 Ko gzip). Le service worker les met tous en cache
// à l'installation (`globPatterns`) : un écran s'ouvre hors ligne comme avant, seul le premier affichage est allégé.
const CollectScreen = lazy(() =>
  import('../features/sales/CollectScreen.js').then((m) => ({ default: m.CollectScreen })),
);
const StockScreen = lazy(() =>
  import('../features/stock/StockScreen.js').then((m) => ({ default: m.StockScreen })),
);
const LossScreen = lazy(() =>
  import('../features/stock/LossScreen.js').then((m) => ({ default: m.LossScreen })),
);
const ReceiveTransferScreen = lazy(() =>
  import('../features/stock/ReceiveTransferScreen.js').then((m) => ({
    default: m.ReceiveTransferScreen,
  })),
);
const BlindReceiptScreen = lazy(() =>
  import('../features/stock/BlindReceiptScreen.js').then((m) => ({
    default: m.BlindReceiptScreen,
  })),
);
const ConsumptionScreen = lazy(() =>
  import('../features/stock/ConsumptionScreen.js').then((m) => ({ default: m.ConsumptionScreen })),
);
const CashSessionScreen = lazy(() =>
  import('../features/cash/CashSessionScreen.js').then((m) => ({ default: m.CashSessionScreen })),
);
const CashTransfersScreen = lazy(() =>
  import('../features/cash/CashTransfersScreen.js').then((m) => ({
    default: m.CashTransfersScreen,
  })),
);
const TreasuryScreen = lazy(() =>
  import('../features/treasury/TreasuryScreen.js').then((m) => ({ default: m.TreasuryScreen })),
);
const ExpenseScreen = lazy(() =>
  import('../features/finance/ExpenseScreen.js').then((m) => ({ default: m.ExpenseScreen })),
);
const SupplierInvoicesScreen = lazy(() =>
  import('../features/finance/SupplierInvoicesScreen.js').then((m) => ({
    default: m.SupplierInvoicesScreen,
  })),
);
const SupplierPaymentsScreen = lazy(() =>
  import('../features/finance/SupplierPaymentsScreen.js').then((m) => ({
    default: m.SupplierPaymentsScreen,
  })),
);
const CostsScreen = lazy(() =>
  import('../features/finance/CostsScreen.js').then((m) => ({ default: m.CostsScreen })),
);
const ReceivablesScreen = lazy(() =>
  import('../features/finance/ReceivablesScreen.js').then((m) => ({
    default: m.ReceivablesScreen,
  })),
);
const MatchingScreen = lazy(() =>
  import('../features/procurement/MatchingScreen.js').then((m) => ({ default: m.MatchingScreen })),
);
const ReplenishScreen = lazy(() =>
  import('../features/distribution/ReplenishScreen.js').then((m) => ({
    default: m.ReplenishScreen,
  })),
);
const DistributionScreen = lazy(() =>
  import('../features/distribution/DistributionScreen.js').then((m) => ({
    default: m.DistributionScreen,
  })),
);
const PosHomeScreen = lazy(() =>
  import('../features/distribution/PosHomeScreen.js').then((m) => ({ default: m.PosHomeScreen })),
);
const AllocationsScreen = lazy(() =>
  import('../features/stock/AllocationsScreen.js').then((m) => ({ default: m.AllocationsScreen })),
);
const CountScreen = lazy(() =>
  import('../features/stock/CountScreen.js').then((m) => ({ default: m.CountScreen })),
);
const TransferScreen = lazy(() =>
  import('../features/stock/TransferScreen.js').then((m) => ({ default: m.TransferScreen })),
);
const CustomerScreen = lazy(() =>
  import('../features/crm/CustomerScreen.js').then((m) => ({ default: m.CustomerScreen })),
);
const InteractionScreen = lazy(() =>
  import('../features/crm/InteractionScreen.js').then((m) => ({ default: m.InteractionScreen })),
);
const NewProspectScreen = lazy(() =>
  import('../features/crm/NewProspectScreen.js').then((m) => ({ default: m.NewProspectScreen })),
);
const NewVisitScreen = lazy(() =>
  import('../features/crm/NewVisitScreen.js').then((m) => ({ default: m.NewVisitScreen })),
);
const PerformanceScreen = lazy(() =>
  import('../features/crm/PerformanceScreen.js').then((m) => ({ default: m.PerformanceScreen })),
);
const ServiceScreen = lazy(() =>
  import('../features/fieldwork/ServiceScreen.js').then((m) => ({ default: m.ServiceScreen })),
);
const PriceRulesScreen = lazy(() =>
  import('../features/pricing/PriceRulesScreen.js').then((m) => ({ default: m.PriceRulesScreen })),
);
const CatalogScreen = lazy(() =>
  import('../features/catalog/CatalogScreen.js').then((m) => ({ default: m.CatalogScreen })),
);
const LedgerScreen = lazy(() =>
  import('../features/stock/LedgerScreen.js').then((m) => ({ default: m.LedgerScreen })),
);
const OutputScreen = lazy(() =>
  import('../features/production/OutputScreen.js').then((m) => ({ default: m.OutputScreen })),
);
const LotSetupScreen = lazy(() =>
  import('../features/production/LotSetupScreen.js').then((m) => ({ default: m.LotSetupScreen })),
);
const IncubationScreen = lazy(() =>
  import('../features/production/IncubationScreen.js').then((m) => ({
    default: m.IncubationScreen,
  })),
);
const LotSheetScreen = lazy(() =>
  import('../features/production/LotSheetScreen.js').then((m) => ({ default: m.LotSheetScreen })),
);
const TargetsScreen = lazy(() =>
  import('../features/crm/TargetsScreen.js').then((m) => ({ default: m.TargetsScreen })),
);
const SuppliersScreen = lazy(() =>
  import('../features/procurement/SuppliersScreen.js').then((m) => ({
    default: m.SuppliersScreen,
  })),
);
const PurchaseOrdersScreen = lazy(() =>
  import('../features/procurement/OrdersScreen.js').then((m) => ({ default: m.OrdersScreen })),
);
const PriceSimulatorScreen = lazy(() =>
  import('../features/pricing/PriceSimulatorScreen.js').then((m) => ({
    default: m.PriceSimulatorScreen,
  })),
);
const ReceiptScreen = lazy(() =>
  import('../features/procurement/ReceiptScreen.js').then((m) => ({ default: m.ReceiptScreen })),
);
const RequestScreen = lazy(() =>
  import('../features/procurement/RequestScreen.js').then((m) => ({ default: m.RequestScreen })),
);
const DailyEntryScreen = lazy(() =>
  import('../features/production/DailyEntryScreen.js').then((m) => ({
    default: m.DailyEntryScreen,
  })),
);
const EggCollectionScreen = lazy(() =>
  import('../features/production/EggCollectionScreen.js').then((m) => ({
    default: m.EggCollectionScreen,
  })),
);
const LotsScreen = lazy(() =>
  import('../features/production/LotsScreen.js').then((m) => ({ default: m.LotsScreen })),
);
const PortfolioScreen = lazy(() =>
  import('../features/crm/PortfolioScreen.js').then((m) => ({ default: m.PortfolioScreen })),
);
const DeliverScreen = lazy(() =>
  import('../features/sales/DeliverScreen.js').then((m) => ({ default: m.DeliverScreen })),
);
const NewOrderScreen = lazy(() =>
  import('../features/sales/NewOrderScreen.js').then((m) => ({ default: m.NewOrderScreen })),
);
const NewSaleScreen = lazy(() =>
  import('../features/sales/NewSaleScreen.js').then((m) => ({ default: m.NewSaleScreen })),
);
const OrderDetailScreen = lazy(() =>
  import('../features/sales/OrderDetailScreen.js').then((m) => ({ default: m.OrderDetailScreen })),
);
const OrdersScreen = lazy(() =>
  import('../features/sales/OrdersScreen.js').then((m) => ({ default: m.OrdersScreen })),
);
const SaleDetailScreen = lazy(() =>
  import('../features/sales/SaleDetailScreen.js').then((m) => ({ default: m.SaleDetailScreen })),
);
const SalesListScreen = lazy(() =>
  import('../features/sales/SalesListScreen.js').then((m) => ({ default: m.SalesListScreen })),
);
const DevicesScreen = lazy(() =>
  import('../features/devices/DevicesScreen.js').then((m) => ({ default: m.DevicesScreen })),
);
const ApprovalsScreen = lazy(() =>
  import('../features/approvals/ApprovalsScreen.js').then((m) => ({ default: m.ApprovalsScreen })),
);
const UsersScreen = lazy(() =>
  import('../features/users/UsersScreen.js').then((m) => ({ default: m.UsersScreen })),
);
// Page de référence des composants (ADR-049), réservée au développement : `import.meta.env.DEV` vaut
// `false` à la construction, la branche et son import sont supprimés (rien de la galerie dans `dist`).
const ComponentGallery = import.meta.env.DEV
  ? lazy(() => import('../dev/ComponentGallery.js').then((m) => ({ default: m.ComponentGallery })))
  : null;

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
  // MP-08 (AV-251) : mot de passe provisoire à changer avant toute autre chose.
  if (state.status === 'password_change_required') return <PasswordChangeScreen />;
  if (state.status === 'pin_setup_required') return <PinSetupScreen />;
  if (state.status === 'locked') return <PinUnlockScreen />;

  const onLogout = async () => {
    // Opérations et photos encore à envoyer (MP-10 : une photo de mortalité attend son auteur).
    const pending =
      (await countPending(getDb())) + (await pendingAttachments(getDb(), state.userId)).count;
    const message =
      pending > 0 ? t('auth.logout_confirm_pending', { count: pending }) : t('auth.logout_confirm');
    if (window.confirm(message)) await logout();
  };

  return (
    <Shell onLogout={() => void onLogout()}>
      <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<p role="status">{t('app.screen_loading')}</p>}>
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
            <Route path={ROUTES.cashTransfers} element={<CashTransfersScreen />} />
            <Route path={ROUTES.treasury} element={<TreasuryScreen />} />
            <Route path={ROUTES.expenses} element={<ExpenseScreen />} />
            <Route path={ROUTES.supplierInvoices} element={<SupplierInvoicesScreen />} />
            <Route path={ROUTES.supplierPayments} element={<SupplierPaymentsScreen />} />
            <Route path={ROUTES.costsMargins} element={<CostsScreen />} />
            <Route path={ROUTES.receivables} element={<ReceivablesScreen />} />
            <Route path={ROUTES.orderMatching} element={<MatchingScreen />} />
            <Route path={ROUTES.replenish} element={<ReplenishScreen />} />
            <Route path={ROUTES.distribution} element={<DistributionScreen />} />
            <Route path={ROUTES.posHome} element={<PosHomeScreen />} />
            <Route path={ROUTES.allocations} element={<AllocationsScreen />} />
            <Route path={ROUTES.devices} element={<DevicesScreen />} />
            <Route path={ROUTES.approvals} element={<ApprovalsScreen />} />
            <Route path={ROUTES.users} element={<UsersScreen />} />
            {ComponentGallery ? (
              <Route path="/dev/composants" element={<ComponentGallery />} />
            ) : null}
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
        </Suspense>
      </ErrorBoundary>
    </Shell>
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
