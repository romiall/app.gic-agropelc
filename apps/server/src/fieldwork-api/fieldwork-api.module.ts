/** Composition transport (comme `inventory-api/`) : rencontre de `fieldwork`, `identity` et `audit`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { FieldworkReadController } from './fieldwork-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [FieldworkReadController],
})
export class FieldworkApiModule {}
