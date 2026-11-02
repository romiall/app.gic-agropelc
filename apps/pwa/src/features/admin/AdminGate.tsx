/**
 * Garde commune des écrans d'administration en ligne : tant que la session n'est pas déverrouillée, un
 * squelette ; hors ligne, un message (ces écrans écrivent par commandes jugées par le serveur au moment de
 * l'envoi, jamais en différé). Les enfants ne sont montés que lorsque l'écran est utilisable, si bien que
 * leurs lectures ne partent jamais hors ligne.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, PageHeader, SkeletonRows } from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import '../users/admin.css';

interface AdminGateProps {
  readonly title: string;
  readonly children: ReactNode;
}

export function AdminGate({ title, children }: AdminGateProps) {
  const { t } = useTranslation();
  const { state } = useAuth();
  const online = useOnline();
  if (state.status !== 'unlocked') {
    return (
      <section className="sale adm-screen" aria-busy="true">
        <PageHeader title={title} />
        <SkeletonRows />
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale adm-screen">
        <PageHeader title={title} />
        <Banner tone="muted" role="status">
          {t('admin_config.online_only')}
        </Banner>
      </section>
    );
  }
  return <section className="sale adm-screen">{children}</section>;
}
