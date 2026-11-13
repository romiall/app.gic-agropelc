/**
 * Panneau « Aide » de chaque page (AV-525, ADR-058) : à quoi sert la page, ce que le profil connecté y peut
 * faire, ce que seul un autre rôle peut y faire (et lequel : c'est la réponse à « pourquoi je ne vois pas
 * ce bouton ? »), ce qu'il faut avoir fait avant, et l'étape suivante du parcours. Calculé sur l'appareil
 * à partir des rôles mémorisés : il s'ouvre aussi hors ligne. Il décrit, il n'autorise rien : le serveur
 * revérifie chaque permission.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, LinkButton, Sheet } from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { ActionLine } from './ActionLine.js';
import { helpFor, viewOf } from './help-logic.js';
import { roleLabel } from './help-types.js';
import './help.css';

export interface HelpSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly pathname: string;
  /** Rôles du profil connecté ; vide : jamais connus de l'appareil. */
  readonly roles: readonly string[];
}

export function HelpSheet({ open, onClose, pathname, roles }: HelpSheetProps) {
  const { t } = useTranslation();
  const help = helpFor(pathname);
  const view = help ? viewOf(help, roles) : null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={help ? help.title : t('help.title')}
      footer={
        <LinkButton to={ROUTES.help} variant="tonal" icon="help">
          {t('help.open_guide')}
        </LinkButton>
      }
    >
      {help && view ? (
        <div className="help-body">
          <p className="help-purpose">{help.purpose}</p>
          {!view.accessible ? (
            <p className="help-reserved-note" role="note">
              {t('help.screen_reserved')}
            </p>
          ) : null}
          {help.before && help.before.length > 0 ? (
            <section aria-labelledby="help-before">
              <h3 id="help-before">{t('help.before')}</h3>
              <ul className="help-list">
                {help.before.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="help-can">
            <h3 id="help-can">{t('help.can')}</h3>
            {view.doable.length === 0 ? (
              <p className="help-empty">{t('help.can_none')}</p>
            ) : (
              <ul className="help-actions">
                {view.doable.map((action) => (
                  <ActionLine key={action.label} action={action} />
                ))}
              </ul>
            )}
          </section>
          {view.reserved.length > 0 ? (
            <section aria-labelledby="help-reserved">
              <h3 id="help-reserved">{t('help.reserved')}</h3>
              <p className="help-empty">{t('help.reserved_hint')}</p>
              <ul className="help-actions">
                {view.reserved.map(({ action, roles: allowed }) => (
                  <li key={action.label} className="help-action is-reserved">
                    <span className="help-action-head">
                      <Icon name="lock" size={18} />
                      <strong>{action.label}</strong>
                    </span>
                    <span className="help-action-what">{action.what}</span>
                    {allowed.length > 0 ? (
                      <span className="help-action-roles">
                        {t('help.roles', { roles: allowed.map(roleLabel).join(', ') })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {help.next && help.next.length > 0 ? (
            <section aria-labelledby="help-next">
              <h3 id="help-next">{t('help.next')}</h3>
              <ul className="help-list">
                {help.next.map((link) => (
                  <li key={link.to + link.label}>
                    <Link className="help-link" to={link.to}>
                      {link.label}
                    </Link>{' '}
                    <span className="help-why">— {link.why}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <p className="help-empty">{t('help.none')}</p>
      )}
    </Sheet>
  );
}
