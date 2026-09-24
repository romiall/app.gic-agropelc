import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { CommandPipelineService } from './command-pipeline.service.js';
import { CommandsController } from './commands.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [CommandsController],
  providers: [CommandPipelineService],
  exports: [CommandPipelineService],
})
export class CommandsModule {}
