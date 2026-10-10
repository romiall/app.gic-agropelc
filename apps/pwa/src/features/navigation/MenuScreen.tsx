/**
 * Menu par rôle (ECR-ADM-03, UX-01 ; ADR-050) : les actions du jour de chaque rôle qui mènent à un
 * écran livré, puis tous les écrans proposés à l'utilisateur, regroupés par domaine. Construit à
 * partir de la navigation mémorisée sur l'appareil : utilisable hors ligne, contrairement à
 * l'accueil calculé par le serveur. La déconnexion se trouve ici, pour alléger l'en-tête mobile.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext.js';
import { routeOfAction, SCREEN_GROUPS, screensForRoles } from '../../app/screens.js';
import { useRememberedNavigation } from './navigation-store.js';

interface MenuScreenProps {
  readonly onLogout: () => void;
}

export function MenuScreen({ onLogout }: MenuScreenProps) {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);

  if (navigation === undefined) {
    return (
      <section className="menu" aria-busy="true">
        <h1>{t('nav.menu_title')}</h1>
      </section>
    );
  }

  const roles = navigation?.roles ?? [];
  const screens = screensForRoles(roles);
  const seen = new Set<string>();
  const actions = (navigation?.sections ?? []).flatMap((section) =>
    section.actions.flatMap((action) => {
      const route = routeOfAction(action);
      if (!route || route === '/' || seen.has(action.code)) return [];
      seen.add(action.code);
      return [{ ...action, route }];
    }),
  );

  return (
    <section className="menu">
      <h1>{t('nav.menu_title')}</h1>
      {navigation === null ? (
        <p className="home-muted">{t('nav.no_navigation')}</p>
      ) : (
        <p className="home-muted">
          {navigation.sections.map((section) => section.roleLabel).join(' · ')}
        </p>
      )}

      {actions.length > 0 ? (
        <section aria-labelledby="menu-actions-title">
          <h2 id="menu-actions-title">{t('nav.actions_title')}</h2>
          <div className="home-actions">
            {actions.map((action) => (
              <Link
                key={action.code}
                to={action.route}
                className={`action${action.primary ? ' action-primary' : ''}`}
              >
                <span className="action-label">{action.label}</span>
                {action.hint ? <span className="action-hint">{action.hint}</span> : null}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {SCREEN_GROUPS.map((group) => {
        const inGroup = screens.filter((screen) => screen.group === group);
        if (inGroup.length === 0) return null;
        const titleId = `menu-group-${group}`;
        return (
          <section key={group} aria-labelledby={titleId}>
            <h2 id={titleId}>{t(`nav.groups.${group}`)}</h2>
            <ul className="menu-list">
              {inGroup.map((screen) => (
                <li key={screen.id}>
                  <Link to={screen.path}>
                    <span>{t(`nav.screens.${screen.labelKey}`)}</span>
                    {screen.offline ? (
                      <small className="menu-offline">{t('nav.offline_ok')}</small>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <button type="button" className="secondary menu-logout" onClick={onLogout}>
        {t('auth.logout')}
      </button>
    </section>
  );
}
