/**
 * Invite « Ouvrir la caisse » (BR-DIS-005, AV-233) : sur un écran d'encaissement au PDV, avant toute
 * saisie. `MISSING` : aucune caisse ouverte vue par l'appareil ; en ligne, un encaissement en espèces
 * sera bloqué, hors ligne il sera enregistré et signalé à la Finance. `UNKNOWN` : la caisse du PDV
 * n'est pas servie à l'appareil (rôle sans `finance.cash.read` sur le site) : rappel sans blocage. Le
 * lien vers la caisse n'est proposé qu'aux rôles qui l'ouvrent (`finance.cash_session.operate`).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';

export function CashSessionPrompt({
  coverage,
  online,
  userId,
}: {
  readonly coverage: 'MISSING' | 'UNKNOWN';
  readonly online: boolean;
  readonly userId: string;
}) {
  const { t } = useTranslation();
  const navigation = useRememberedNavigation(userId);
  const canOpen = holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.cashSessionOperate);
  const message =
    coverage === 'UNKNOWN'
      ? 'cash.prompt.unknown'
      : online
        ? 'cash.prompt.closed_online'
        : 'cash.prompt.closed_offline';
  return (
    <div className="home-banner" role="status">
      <p>{t(message)}</p>
      {canOpen ? (
        <Link to={ROUTES.cash} className="action action-compact">
          <span className="action-label">{t('cash.prompt.open_link')}</span>
        </Link>
      ) : null}
    </div>
  );
}
