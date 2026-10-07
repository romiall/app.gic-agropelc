/** Composition transport (comme `production-api/`) : l'accueil par rôle rencontre tous les modules de lecture. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { HomeController } from './home.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [HomeController],
})
export class HomeApiModule {}
