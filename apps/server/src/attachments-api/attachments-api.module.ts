/**
 * `/attachments/*` (P0-13) et `/attachment-archives/*` (AV-539, ADR-070). Composition transport (comme `sync/`,
 * `organization-api/`) : `IdentityModule` fournit `AuthGuard` et les clés des jetons ; `attachments`/`platform` sont
 * toujours disponibles (note sous `03-graphe-dependances.md`).
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { AttachmentArchiveController } from './archive/archive.controller.js';
import { AttachmentArchiveService } from './archive/archive-service.js';
import { AttachmentUploadController } from './upload.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [AttachmentUploadController, AttachmentArchiveController],
  providers: [AttachmentArchiveService],
})
export class AttachmentsApiModule {}
