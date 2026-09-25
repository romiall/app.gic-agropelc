/**
 * `GET /health` — sans authentification, sans dépendance (observabilité complète : P0-16).
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '../platform/http/authorization.decorators.js';

@Controller('health')
export class HealthController {
  @Get()
  @Public()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
