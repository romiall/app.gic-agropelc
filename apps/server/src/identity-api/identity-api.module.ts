/** Composition transport (comme `inventory-api/`) : lectures d'`identity` (MP-06 : appareils ; MP-08 : utilisateurs ; MP-13 : rôles). */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { DevicesReadController } from './devices-read.controller.js';
import { UsersReadController } from './users-read.controller.js';
import { RolesReadController } from './roles-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [DevicesReadController, UsersReadController, RolesReadController],
})
export class IdentityApiModule {}
