/**
 * Page « Plus » (ECR-ADM-03, UX-01 ; ADR-036, ADR-049) : les actions du jour de chaque rôle qui mènent à
 * un écran livré, puis tous les écrans proposés à l'utilisateur, regroupés par domaine, l'apparence et la
 * déconnexion. Construite à partir de la navigation mémorisée sur l'appareil : utilisable hors ligne,
 * contrairement à l'accueil calculé par le serveur.
 */
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  List,
  ListRow,
  PageHeader,
  Section,
  ThemeSwitcher,
} from '../../components/ui/index.js';
import { routeOfAction } from '../../app/screens.js';
import { useAuth } from '../auth/AuthContext.js';
import { iconOfAction, sidebarGroups } from '../shell/nav-config.js';
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
        <PageHeader title={t('nav.menu_title')} />
      </section>
    );
  }

  const roles = navigation?.roles ?? [];
  const groups = sidebarGroups(roles);
  const seen = new Set<string>();
  const actions = (navigation?.sections ?? []).flatMap((section) =>
    section.actions.flatMap((action) => {
      const route = routeOfAction(action, section.role);
      // Une action dont le code est commun à deux rôles peut mener à deux écrans (RECEIPTS : réception
      // pour le responsable de ferme, rapprochement pour le responsable des achats) : un lien par route.
      if (!route || route === '/' || seen.has(`${action.code}|${route}`)) return [];
      seen.add(`${action.code}|${route}`);
      return [{ ...action, route }];
    }),
  );

  return (
    <div className="menu stack">
      <PageHeader
        title={t('nav.menu_title')}
        subtitle={
          navigation === null
            ? t('nav.no_navigation')
            : navigation.sections.map((section) => section.roleLabel).join(' · ')
        }
      />

      {actions.length > 0 ? (
        <Section title={t('nav.actions_title')}>
          <List>
            {actions.map((action) => (
              <ListRow
                key={`${action.code}|${action.route}`}
                icon={iconOfAction(action.code)}
                title={action.label}
                subtitle={action.hint ?? undefined}
                to={action.route}
              />
            ))}
          </List>
        </Section>
      ) : null}

      {groups.map(({ group, items }) => (
        <Section key={group} title={t(`nav.groups.${group}`)}>
          <List>
            {items.map((item) => (
              <ListRow
                key={item.id}
                icon={item.icon}
                title={t(`nav.screens.${item.labelKey}`)}
                to={item.path}
                badge={
                  item.offline ? (
                    <Badge tone="ok" plain>
                      {t('nav.offline_ok')}
                    </Badge>
                  ) : undefined
                }
              />
            ))}
          </List>
        </Section>
      ))}

      <Section title={t('ui.theme.title')}>
        <ThemeSwitcher />
      </Section>

      <Button variant="outline" block icon="logout" onClick={onLogout}>
        {t('auth.logout')}
      </Button>
    </div>
  );
}
