import { Module } from '@nestjs/common';
import { ProcurementCommandsRegistrar } from './application/commands/register-procurement-commands.js';

@Module({
  providers: [ProcurementCommandsRegistrar],
})
export class ProcurementModule {}
