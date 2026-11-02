/**
 * Composition transport (comme `identity-api/`) : file de validation (MP-07, ECR-ADM-08) et lecture des
 * politiques de contrôle (RP-1, ECR-ADM-07). `identity` fournit le garde d'authentification (clés JWT).
 */
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../modules/approvals/approvals.module.js';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { ApprovalsInboxController } from './approvals-inbox.controller.js';
import { PoliciesReadController } from './policies-read.controller.js';

@Module({
  imports: [ApprovalsModule, IdentityModule],
  controllers: [ApprovalsInboxController, PoliciesReadController],
})
export class ApprovalsApiModule {}
