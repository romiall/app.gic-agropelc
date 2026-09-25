import { Module } from '@nestjs/common';
import { jwtKeysProvider, JWT_KEYS } from './jwt-keys.provider.js';
import { AuthGuard } from './api/auth.guard.js';
import { IdentityCommandsRegistrar } from './application/commands/register-identity-commands.js';

@Module({
  providers: [jwtKeysProvider, AuthGuard, IdentityCommandsRegistrar],
  exports: [JWT_KEYS, AuthGuard],
})
export class IdentityModule {}
