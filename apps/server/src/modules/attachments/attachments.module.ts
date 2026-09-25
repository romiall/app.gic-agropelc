import { Module } from '@nestjs/common';
import { AttachmentsCommandsRegistrar } from './application/commands/register-attachment-commands.js';

@Module({
  providers: [AttachmentsCommandsRegistrar],
})
export class AttachmentsModule {}
