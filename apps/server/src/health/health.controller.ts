/**
 * `GET /health` — sans authentification, sans dépendance (observabilité complète : P0-16).
 */
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
