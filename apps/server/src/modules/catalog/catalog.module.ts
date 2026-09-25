import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogCommandsRegistrar } from './application/commands/register-catalog-commands.js';
import { CatalogReadController } from './api/catalog-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [CatalogReadController],
  providers: [CatalogCommandsRegistrar],
})
export class CatalogModule {}
