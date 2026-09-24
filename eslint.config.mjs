// Configuration ESLint racine (format plat, ESLint 9).
// NFR-32 (frontières de modules) est vérifiée séparément par dependency-cruiser
// (`pnpm run check:boundaries`), pas par ESLint : voir .dependency-cruiser.cjs.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
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
