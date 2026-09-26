import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { InventoryCommandsRegistrar } from './application/commands/register-inventory-commands.js';

@Module({
  // `ApprovalsModule` : nécessaire côté câblage NestJS pour obtenir
  // `APPROVAL_DECISION_HANDLER_REGISTRY` (déjà autorisé par le graphe de dépendances,
  // `inventory` → `approvals` — voir le commentaire dans `approvals.module.ts`).
  imports: [ApprovalsModule],
  providers: [InventoryCommandsRegistrar],
})
export class InventoryModule {}
