/**
 * NFR-24 (09-non-functional/01-exigences-non-fonctionnelles.md : « 100 % des endpoints
 * authentifiés et soumis au contrôle de portée, sauf /auth/login et webhook authentifié ») :
 * introspection des routes réellement enregistrées par Nest (`DiscoveryService`), pas une
 * liste maintenue à la main qui pourrait diverger silencieusement d'un futur contrôleur.
 * Un ajout de route sans l'un des décorateurs de `platform/http/authorization.decorators.ts`
 * fait échouer ce test — c'est le but (P0-10).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module.js';
import { AuthGuard } from '../src/modules/identity/api/auth.guard.js';
import {
  ENDPOINT_AUTHORIZATION_KEY,
  type EndpointAuthorization,
} from '../src/platform/http/authorization.decorators.js';
import { closeTestDb } from './helpers.js';

process.env.SERVER_DATABASE_URL ??=
  'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';

describe('NFR-24 : couverture des points d’accès', () => {
  it('chaque route déclare une autorisation explicite ; toute route non publique est protégée par AuthGuard', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();

    try {
      const discovery = moduleRef.get(DiscoveryService);
      const scanner = moduleRef.get(MetadataScanner);
      const reflector = moduleRef.get(Reflector);

      const controllers = discovery.getControllers();
      let routeCount = 0;

      for (const wrapper of controllers) {
        const instance = wrapper.instance as object | undefined;
        if (!instance) continue;
        const prototype: object = Object.getPrototypeOf(instance);
        const methodNames = scanner.getAllMethodNames(prototype);

        for (const methodName of methodNames) {
          const handler = (prototype as Record<string, unknown>)[methodName];
          if (typeof handler !== 'function') continue;
          const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
          if (path === undefined) continue; // pas une route (méthode utilitaire du contrôleur)
          routeCount++;

          const authz = reflector.get<EndpointAuthorization | undefined>(
            ENDPOINT_AUTHORIZATION_KEY,
            handler,
          );
          expect(
            authz,
            `${wrapper.name}.${methodName} (${path}) : aucun décorateur d'autorisation ` +
              '(@Public/@SelfScoped/@RequiresPermission/@CommandRegistryDelegated) — NFR-24.',
          ).toBeDefined();

          if (authz!.kind === 'PERMISSION') {
            expect(
              authz!.permissionCode.length,
              `${wrapper.name}.${methodName} : permissionCode vide.`,
            ).toBeGreaterThan(0);
          }

          if (authz!.kind !== 'PUBLIC') {
            const methodGuards =
              (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
            const classGuards =
              (Reflect.getMetadata(GUARDS_METADATA, wrapper.metatype as object) as
                unknown[] | undefined) ?? [];
            const guarded = [...methodGuards, ...classGuards].includes(AuthGuard);
            expect(
              guarded,
              `${wrapper.name}.${methodName} (${path}) : @${authz!.kind} sans @UseGuards(AuthGuard).`,
            ).toBe(true);
          }
        }
      }

      // Un test qui ne trouve aucune route passerait trivialement sans rien vérifier.
      expect(routeCount).toBeGreaterThan(0);
    } finally {
      await moduleRef.close();
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });
});
