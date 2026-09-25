/**
 * `/sync/push`, `/sync/pull` (P0-12). Composition transport (comme `commands/`) :
 * `CommandsModule` fournit {@link CommandPipelineService} (déjà exporté pour `/commands`),
 * `IdentityModule` fournit `AuthGuard`.
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { SyncController } from './sync.controller.js';
import { SyncPushService } from './sync-push.service.js';
import { SyncPullService } from './sync-pull.service.js';

@Module({
  imports: [IdentityModule, CommandsModule],
  controllers: [SyncController],
  providers: [SyncPushService, SyncPullService],
})
export class SyncModule {}
