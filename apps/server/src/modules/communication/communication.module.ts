/**
 * Module `communication` (P9 ; ADR-070) : commandes d'alerte, de notification et de note. Les lectures
 * HTTP sont dans la couche de transport `communication-api/` (P9-06). Le consommateur d'événements et les
 * tâches planifiées sont dans `CommunicationJobsModule`, importé aussi par le processus worker.
 */
import { Module } from '@nestjs/common';
import { CommunicationCommandsRegistrar } from './application/commands/register-communication-commands.js';

@Module({
  providers: [CommunicationCommandsRegistrar],
})
export class CommunicationModule {}
