/**
 * Invite « Ouvrir la caisse » (BR-DIS-005, AV-305) : sur un écran d'encaissement au PDV, sans caisse
 * ouverte vue par l'appareil, avant toute saisie. En ligne, un encaissement en espèces sera bloqué ;
 * hors ligne, il sera enregistré et signalé à la Finance.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ROUTES } from '../../app/screens.js';

export function CashSessionPrompt({ online }: { readonly online: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="home-banner" role="status">
      <p>{t(online ? 'cash.prompt.closed_online' : 'cash.prompt.closed_offline')}</p>
      <Link to={ROUTES.cash} className="action action-compact">
        <span className="action-label">{t('cash.prompt.open_link')}</span>
      </Link>
    </div>
  );
}
