// Configuration ESLint racine (format plat, ESLint 9).
// NFR-32 (frontières de modules) est vérifiée séparément par dependency-cruiser
// (`pnpm run check:boundaries`), pas par ESLint : voir .dependency-cruiser.cjs.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/dev-dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  {
    // Scripts Node exécutés directement, hors TypeScript compilé (tools/*.mjs,
    // configuration *.cjs) : sans ceci, no-undef (hérité de js.configs.recommended)
    // rejette process/console, absents des globals par défaut d'ESLint.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript (pnpm run typecheck) vérifie déjà les identifiants non définis avec la
      // connaissance complète des libs (Node, DOM…) ; no-undef, analyse statique d'ESLint
      // sans cette connaissance, produit des faux positifs sur ces mêmes globals (ex. URL).
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Scripts CLI (dbmate seeds) : la sortie console *est* l'interface utilisateur. Depuis
    // P0-16, `apps/server/src/main.ts`/`worker.ts` journalisent via `appLogger` (pino
    // structuré) et n'ont plus besoin de cette dérogation.
    files: ['db/seeds/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // apps/pwa (React) : règles des hooks (dépendances exhaustives, appels au niveau racine)
    // et alerte sur un export non composant dans un fichier de composant (Vite Fast Refresh).
    files: ['apps/pwa/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // NestJS (apps/server) résout l'injection de dépendances par métadonnées de décorateur
    // (`emitDecoratorMetadata`, tsconfig.json) : le type d'un paramètre de constructeur doit
    // rester un import de **valeur**, même quand il n'apparaît autrement qu'en position de
    // type dans le fichier — `import type` efface l'import à la compilation et casse la
    // résolution DI à l'exécution. `consistent-type-imports` ne peut pas distinguer ce cas
    // d'un import réellement type-only ; désactivé ici plutôt que corrigé au cas par cas.
    files: ['apps/server/src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // packages/domain n'a aucune entrée-sortie implicite (ADR-021, K1) : l'horloge et les
    // identifiants sont injectés (Clock, IdGenerator), jamais lus directement. Interdit
    // seulement la lecture de l'heure *courante* (`new Date()` sans argument, `Date.now()`) :
    // utiliser `Date` comme type, ou construire un `Date` à partir d'une valeur déjà connue
    // (ex. FixedClock, conversions dans business-day.ts), reste parfaitement légitime et
    // déterministe. Seules les implémentations concrètes (system-clock.ts, uuid.ts,
    // uuidv7-generator.ts) ont le droit de lire l'horloge système ou le générateur natif ;
    // elles sont exclues ici et branchées uniquement dans apps/server et apps/pwa
    // (composition racine).
    files: ['packages/domain/src/**/*.ts'],
    ignores: [
      'packages/domain/src/**/*.test.ts',
      '**/system-clock.ts',
      '**/uuid.ts',
      '**/uuidv7-generator.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "packages/domain ne lit pas l'heure courante : injecter Clock et appeler clock.now().",
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "packages/domain ne lit pas l'heure courante : injecter Clock et appeler clock.now().",
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'crypto',
          property: 'randomUUID',
          message: 'Utiliser IdGenerator (injecté), pas crypto.randomUUID() directement.',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'Aucun aléa non injecté dans packages/domain (déterminisme testable).',
        },
      ],
    },
  },
  prettierConfig,
];
