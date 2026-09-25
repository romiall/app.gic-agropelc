import { Module } from '@nestjs/common';
import { jwtKeysProvider, JWT_KEYS } from './jwt-keys.provider.js';
import { AuthGuard } from './api/auth.guard.js';
import { AuthController } from './api/auth.controller.js';
import { IdentityCommandsRegistrar } from './application/commands/register-identity-commands.js';

@Module({
  controllers: [AuthController],
  providers: [jwtKeysProvider, AuthGuard, IdentityCommandsRegistrar],
  exports: [JWT_KEYS, AuthGuard],
})
export class IdentityModule {}
