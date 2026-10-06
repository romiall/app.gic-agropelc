/**
 * `GET /` — page d'accueil de l'API, sans authentification. L'API n'est pas l'application : une
 * personne qui ouvre l'adresse du serveur dans un navigateur voit où trouver l'application plutôt
 * qu'une erreur 404. En développement, la page renvoie vers la PWA (`apps/pwa`, port 5173) ; en
 * production l'application est servie à son adresse habituelle (ADR-024), qu'elle ne devine pas.
 */
import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../platform/http/authorization.decorators.js';

const PWA_DEV_URL = 'http://localhost:5173';

function page(isDevelopment: boolean): string {
  const open = isDevelopment
    ? `<p><a class="button" href="${PWA_DEV_URL}">Ouvrir l’application</a></p>
      <p class="hint">Adresse de développement : ${PWA_DEV_URL}</p>`
    : '<p class="hint">Ouvrez l’application depuis son adresse habituelle.</p>';
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GIC AGROPELC — Serveur</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
        background: #f5f5f0; color: #1a1a1a; font-family: system-ui, 'Segoe UI', sans-serif; }
      main { max-width: 420px; width: 100%; background: #fff; border: 1px solid #dcdcd2;
        border-radius: 12px; padding: 28px 24px; text-align: center; }
      h1 { margin: 0 0 4px; font-size: 22px; color: #0b3d1e; }
      p { margin: 10px 0; line-height: 1.5; }
      .status { display: inline-block; padding: 4px 12px; border-radius: 999px; background: #e3f3e6;
        color: #1e7a34; font-weight: 600; font-size: 14px; }
      .button { display: inline-block; margin-top: 8px; padding: 12px 22px; border-radius: 8px;
        background: #0b3d1e; color: #fff; text-decoration: none; font-weight: 600; }
      .hint { color: #5c5c5c; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>GIC AGROPELC</h1>
      <p><span class="status">Serveur en fonctionnement</span></p>
      <p>Cette adresse est celle du serveur, pas celle de l’application.</p>
      ${open}
    </main>
  </body>
</html>`;
}

@Controller()
export class RootController {
  @Get()
  @Public()
  @Header('content-type', 'text/html; charset=utf-8')
  home(): string {
    return page(process.env['NODE_ENV'] !== 'production');
  }
}
