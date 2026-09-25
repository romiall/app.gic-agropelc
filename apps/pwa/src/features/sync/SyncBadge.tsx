/**
 * Pastille de synchronisation (UX-04), toujours visible dans l'en-tête. Lien vers
 * ECR-SYN-01 pour le détail des opérations en attente.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSyncStatus } from './useSyncStatus.js';

export function SyncBadge() {
  const { t } = useTranslation();
  const status = useSyncStatus();
  if (!status) return null;

  const label = t(status.badge.labelKey, status.badge.labelParams ?? {});
  return (
    <Link
      to="/synchronisation"
      className="sync-badge"
      data-color={status.badge.color}
      aria-label={label}
    >
      <span className="sync-badge-dot" aria-hidden="true" />
      {label}
    </Link>
  );
}
