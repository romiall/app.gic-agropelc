/** Une action de l'aide : nature, libellé, ce qu'elle fait, lien vers l'écran où elle se fait (AV-525). */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Icon } from '../../components/ui/index.js';
import { KIND_ICON } from './help-icons.js';
import type { HelpAction } from './help-types.js';
import './help.css';

export function ActionLine({ action }: { readonly action: HelpAction }) {
  const { t } = useTranslation();
  return (
    <li className="help-action">
      <span className="help-action-head">
        <Icon name={KIND_ICON[action.kind ?? 'go']} size={18} />
        <strong>{action.label}</strong>
        {action.online ? <Badge tone="info">{t('help.online')}</Badge> : null}
      </span>
      <span className="help-action-what">{action.what}</span>
      {action.to ? (
        <Link className="help-link" to={action.to}>
          {t('help.go')}
        </Link>
      ) : null}
    </li>
  );
}
