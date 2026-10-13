/** Composition transport (comme `inventory-api/`) : lectures d'`identity` (MP-06 : appareils). */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { DevicesReadController } from './devices-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [DevicesReadController],
})
export class IdentityApiModule {}
