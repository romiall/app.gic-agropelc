/** Composition transport (comme `organization-api/`, `audit-api/`) : rencontre de `catalog` et `identity`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { CatalogReadController } from './catalog-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [CatalogReadController],
})
export class CatalogApiModule {}
