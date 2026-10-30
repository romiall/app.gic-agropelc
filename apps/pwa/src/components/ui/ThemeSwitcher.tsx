/**
 * Réglage de l'apparence (ADR-049) : Clair (par défaut), Sombre, Automatique (suit le téléphone).
 * Placé dans le menu du compte et dans la page « Plus ».
 */
import { useTranslation } from 'react-i18next';
import { Segmented } from './Form.js';
import { useThemePreference, type ThemePreference } from './theme.js';

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const [theme, setTheme] = useThemePreference();
  return (
    <Segmented<ThemePreference>
      label={t('ui.theme.title')}
      value={theme}
      onChange={setTheme}
      options={[
        { value: 'light', label: t('ui.theme.light') },
        { value: 'dark', label: t('ui.theme.dark') },
        { value: 'auto', label: t('ui.theme.auto') },
      ]}
    />
  );
}
