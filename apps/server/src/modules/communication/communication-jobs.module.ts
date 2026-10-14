/**
 * Consommateur d'événements et tâches planifiées de `communication` (P9-04 : consommateur
 * `communication.alerts` ; P9-05 : escalade ; P9-10 : consommateur en échec). Module séparé de
 * `CommunicationModule` (comme `InventoryJobsModule`) : il ne dépend que de `platform`, pour être importé
 * aussi par le processus worker sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { AlertsConsumerRegistrar } from './application/events/register-alerts-consumer.js';

@Module({
  providers: [AlertsConsumerRegistrar],
})
export class CommunicationJobsModule {}
