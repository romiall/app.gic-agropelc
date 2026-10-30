/**
 * Pastille de synchronisation (UX-04), toujours visible dans la barre du haut. Lien vers ECR-SYN-01 pour
 * le détail des opérations en attente. Le sens ne repose pas sur la couleur seule : icône et texte
 * (le texte n'est masqué que lorsque tout est synchronisé et que l'écran est étroit ; il reste lu).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import type { BadgeColor } from '../../sync/badge-state.js';
import { useSyncStatus } from './useSyncStatus.js';

const ICON: Record<BadgeColor, IconName> = {
  green: 'check',
  orange: 'sync',
  red: 'alert',
  grey: 'offline',
};

export function SyncBadge() {
  const { t } = useTranslation();
  const status = useSyncStatus();
  if (!status) return null;

  const label = t(status.badge.labelKey, status.badge.labelParams ?? {});
  return (
    <Link to={ROUTES.sync} className="sync-pill" data-color={status.badge.color} aria-label={label}>
      <Icon name={ICON[status.badge.color]} size={16} />
      <span className="sync-pill-label">{label}</span>
    </Link>
  );
}
