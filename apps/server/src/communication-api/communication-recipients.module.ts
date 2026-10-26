/**
 * Fournit les adaptateurs du résolveur de destinataires d'alerte (P9-05 ; ADR-062 §2) et du résolveur
 * d'audience des notes (P9-11 ; ADR-063 §3) au module `communication`.
 * Module **global** : `communication` ne peut pas importer la couche de transport (ADR-060), il
 * réclame le port par son jeton ; l'API et le worker importent ce module au démarrage.
 */
import { Global, Module } from '@nestjs/common';
import {
  ALERT_RECIPIENT_RESOLVER,
  NOTE_AUDIENCE_RESOLVER,
} from '../modules/communication/application/public/index.js';
import { IdentityNoteAudienceResolver } from './identity-note-audience-resolver.js';
import { IdentityRecipientResolver } from './identity-recipient-resolver.js';

@Global()
@Module({
  providers: [
    IdentityRecipientResolver,
    { provide: ALERT_RECIPIENT_RESOLVER, useExisting: IdentityRecipientResolver },
    IdentityNoteAudienceResolver,
    { provide: NOTE_AUDIENCE_RESOLVER, useExisting: IdentityNoteAudienceResolver },
  ],
  exports: [ALERT_RECIPIENT_RESOLVER, NOTE_AUDIENCE_RESOLVER],
})
export class CommunicationRecipientsModule {}
