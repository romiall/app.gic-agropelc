/**
 * Fournit l'adaptateur du résolveur de destinataires au module `communication` (P9-05 ; ADR-072 §2).
 * Module **global** : `communication` ne peut pas importer la couche de transport (ADR-070), il
 * réclame le port par son jeton ; l'API et le worker importent ce module au démarrage.
 */
import { Global, Module } from '@nestjs/common';
import { ALERT_RECIPIENT_RESOLVER } from '../modules/communication/application/public/index.js';
import { IdentityRecipientResolver } from './identity-recipient-resolver.js';

@Global()
@Module({
  providers: [
    IdentityRecipientResolver,
    { provide: ALERT_RECIPIENT_RESOLVER, useExisting: IdentityRecipientResolver },
  ],
  exports: [ALERT_RECIPIENT_RESOLVER],
})
export class CommunicationRecipientsModule {}
