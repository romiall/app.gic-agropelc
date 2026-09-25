/**
 * `/attachments/*` (P0-13). Composition transport (comme `sync/`, `organization-api/`) :
 * `IdentityModule` fournit `AuthGuard` ; `attachments`/`platform` sont toujours disponibles
 * (note sous `03-graphe-dependances.md`).
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { AttachmentUploadController } from './upload.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [AttachmentUploadController],
})
export class AttachmentsApiModule {}
