/** Composition transport (comme `procurement-api/`) : rencontre de `production` et `identity`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { ProductionReadController } from './production-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [ProductionReadController],
})
export class ProductionApiModule {}
