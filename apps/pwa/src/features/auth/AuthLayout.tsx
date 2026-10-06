/**
 * Cadre commun des écrans d'authentification (ECR-ADM-01 connexion, ECR-ADM-02 PIN) : marque,
 * carte centrée, titre, aide et pied de page. Aucune logique : les écrans y placent leur
 * formulaire. UX-11 : zones tactiles >= 44 px, contraste AA, une seule colonne utilisable à
 * une main.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface AuthLayoutProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}

export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  const { t } = useTranslation();
  return (
    <div className="auth-page">
      <header className="auth-brand">
        <img className="auth-logo" src="/pwa-192.svg" alt="" width={56} height={56} />
        <p className="auth-brand-name">{t('app.name')}</p>
        <p className="auth-brand-tagline">{t('app.tagline')}</p>
      </header>
      <main className="auth-card">
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
      </main>
      <footer className="auth-footer">{t('app.footer')}</footer>
    </div>
  );
}
