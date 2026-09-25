import { Module } from '@nestjs/common';
import { CatalogCommandsRegistrar } from './application/commands/register-catalog-commands.js';

@Module({
  providers: [CatalogCommandsRegistrar],
})
export class CatalogModule {}
