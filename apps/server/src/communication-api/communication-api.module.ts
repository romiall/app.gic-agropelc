/**
 * Composition transport des lectures de la communication (P9-06) : alertes, résumé, notifications et
 * règles d'alerte. `identity` fournit le garde d'authentification (clés JWT).
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { CommunicationReadController } from './communication-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [CommunicationReadController],
})
export class CommunicationApiModule {}
