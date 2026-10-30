/**
 * Feuilles de la coquille (ADR-049) : actions rapides du bouton « + » et menu du compte (apparence,
 * synchronisation, déconnexion). Sur ordinateur, la même feuille s'affiche en boîte centrée.
 */
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  List,
  ListRow,
  Section,
  Sheet,
  ThemeSwitcher,
} from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { iconOfAction, type QuickActionGroup } from './nav-config.js';

export interface QuickActionsSheetProps {
  open: boolean;
  onClose: () => void;
  groups: readonly QuickActionGroup[];
}

export function QuickActionsSheet({ open, onClose, groups }: QuickActionsSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t('nav.quick_actions')}>
      {groups.length === 0 ? (
        <p className="muted">{t('nav.quick_empty')}</p>
      ) : (
        groups.map((group) => (
          <section key={group.role} aria-label={group.roleLabel}>
            {groups.length > 1 ? <h3 className="quick-role">{group.roleLabel}</h3> : null}
            <List bare>
              {group.actions.map((action) => (
                <ListRow
                  key={action.key}
                  icon={iconOfAction(action.code)}
                  title={action.label}
                  subtitle={action.hint ?? undefined}
                  to={action.route}
                />
              ))}
            </List>
          </section>
        ))
      )}
    </Sheet>
  );
}

export interface AccountSheetProps {
  open: boolean;
  onClose: () => void;
  userName: string;
  roleLabels: readonly string[];
  onLogout: () => void;
}

export function AccountSheet({ open, onClose, userName, roleLabels, onLogout }: AccountSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('nav.account')}
      footer={
        <Button variant="outline" icon="logout" onClick={onLogout}>
          {t('auth.logout')}
        </Button>
      }
    >
      <div className="account-body">
        <div className="account-card">
          <Avatar name={userName || '?'} large />
          <div>
            <p className="account-name">{userName || t('nav.account')}</p>
            {roleLabels.length > 0 ? <p className="muted">{roleLabels.join(' · ')}</p> : null}
          </div>
        </div>
        <Section title={t('ui.theme.title')} headingLevel="h3">
          <ThemeSwitcher />
        </Section>
        <List>
          <ListRow icon="sync" title={t('nav.screens.sync')} to={ROUTES.sync} />
        </List>
      </div>
    </Sheet>
  );
}
