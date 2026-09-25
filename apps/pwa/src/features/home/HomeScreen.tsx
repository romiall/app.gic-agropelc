/**
 * ECR-ADM-03 « Accueil par rôle » — squelette P0 : vide (UX-01 sera appliqué quand chaque
 * module apporte ses actions et indicateurs, phase par phase).
 */
import { useTranslation } from 'react-i18next';

export function HomeScreen() {
  const { t } = useTranslation();
  return (
    <section>
      <h1>{t('home.title')}</h1>
      <p>{t('home.empty_message')}</p>
    </section>
  );
}
