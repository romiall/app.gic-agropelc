import { Module } from '@nestjs/common';
import { jwtKeysProvider, JWT_KEYS } from './jwt-keys.provider.js';
import { AuthGuard } from './api/auth.guard.js';

@Module({
  providers: [jwtKeysProvider, AuthGuard],
  exports: [JWT_KEYS, AuthGuard],
})
export class IdentityModule {}
