/**
 * `/sync/push`, `/sync/pull` (P0-12) ; file des conflits `GET /sync/conflicts` et commandes
 * `sync.conflict.resolve` / `.dismiss` (P5-17). Composition transport (comme `commands/`) :
 * `CommandsModule` fournit {@link CommandPipelineService} (déjà exporté pour `/commands`),
 * `IdentityModule` fournit `AuthGuard`.
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { SyncController } from './sync.controller.js';
import { SyncPushService } from './sync-push.service.js';
import { SyncPullService } from './sync-pull.service.js';
import { ConflictsReadController } from './conflicts-read.controller.js';
import { SyncConflictCommandsRegistrar } from './conflict-commands.js';

@Module({
  imports: [IdentityModule, CommandsModule],
  controllers: [SyncController, ConflictsReadController],
  providers: [SyncPushService, SyncPullService, SyncConflictCommandsRegistrar],
})
export class SyncModule {}
