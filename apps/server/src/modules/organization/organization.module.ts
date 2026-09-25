import { Module } from '@nestjs/common';
import { OrganizationCommandsRegistrar } from './application/commands/register-organization-commands.js';

@Module({
  providers: [OrganizationCommandsRegistrar],
})
export class OrganizationModule {}
