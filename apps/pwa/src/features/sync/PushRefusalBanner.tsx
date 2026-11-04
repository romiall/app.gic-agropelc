/**
 * Bandeau « le serveur refuse l'envoi » (ADR-052, AV-506). Un lot que le serveur refuse en bloc sans désigner de
 * commande (HTTP 400 alors que chaque enveloppe est valide ici : version de l'application plus ancienne que le
 * serveur, identifiant non conforme) laisse la file immobile ; sans ce témoin, l'utilisateur ne voyait qu'une
 * pastille d'attente qui ne se vide jamais. Le témoin (`SyncMeta.push_refusal`) est posé par l'envoi
 * (`sync/push.ts`) et effacé au premier envoi lu par le serveur.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Banner } from '../../components/ui/index.js';
import { getDb } from '../../storage/db.js';

export function PushRefusalBanner() {
  const { t } = useTranslation();
  const refusal = useLiveQuery(
    async () => (await getDb().syncMeta.get('device'))?.push_refusal ?? null,
    [],
  );
  if (!refusal) return null;
  const code = refusal.code ?? `HTTP ${refusal.status}`;
  return (
    <Banner tone="bad" role="alert">
      {refusal.correlation_id
        ? t('sync.push_refused', { code, reference: refusal.correlation_id })
        : t('sync.push_refused_no_ref', { code })}
    </Banner>
  );
}
