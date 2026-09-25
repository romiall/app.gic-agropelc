/**
 * Enregistre le gestionnaire de tâche `audit.chain.verify_daily` (P0-07) au démarrage.
 * Ne dépend que de `platform` (`audit --> platform`, graphe N1, 03-graphe-dependances.md) :
 * importable aussi bien par le processus API (`app.module.ts`) que par le processus worker
 * (`worker.module.ts`, qui exécute réellement les tâches réclamées) sans jamais tirer
 * `IdentityModule` ni aucun contrôleur HTTP dans ce dernier.
 */
import { Module } from '@nestjs/common';
import { ChainVerificationJob } from './chain-verification-job.js';

@Module({
  providers: [ChainVerificationJob],
})
export class ChainVerificationModule {}
