import { Module } from '@nestjs/common';
import { jwtKeysProvider, JWT_KEYS } from './jwt-keys.provider.js';
import { AuthGuard } from './api/auth.guard.js';
import { AuthController } from './api/auth.controller.js';
import { IdentityCommandsRegistrar } from './application/commands/register-identity-commands.js';
import { RbacCacheConsumerRegistrar } from './application/rbac/register-rbac-cache-consumer.js';
import { RbacCachePoller } from './application/rbac/rbac-cache-poller.js';

@Module({
  controllers: [AuthController],
  providers: [
    jwtKeysProvider,
    AuthGuard,
    IdentityCommandsRegistrar,
    RbacCacheConsumerRegistrar,
    RbacCachePoller,
  ],
  exports: [JWT_KEYS, AuthGuard],
})
export class IdentityModule {}
