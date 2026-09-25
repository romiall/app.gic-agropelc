import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { ProcurementCommandsRegistrar } from './application/commands/register-procurement-commands.js';
import { SupplierReadController } from './api/supplier-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [SupplierReadController],
  providers: [ProcurementCommandsRegistrar],
})
export class ProcurementModule {}
