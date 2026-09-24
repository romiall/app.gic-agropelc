// Contrôle des frontières de modules (NFR-32 ; AT-055 ; REQ-082, REQ-214).
// Source de vérité du graphe : docs/05-architecture/03-graphe-dependances.md et
// docs/05-architecture/02-modules.md (colonne « Autorisées »). Toute modification du
// graphe documenté doit être répercutée ici dans le même commit (règle R8, CLAUDE.md).
//
// Deux familles de règles :
//   1. Un module de apps/server/src/modules/<x> n'importe QUE l'API publique
//      (application/public) d'un autre module — jamais ses dépôts, son domaine interne
//      ou son adaptateur HTTP (05-architecture/01-architecture-logicielle.md §3, règle 1).
//   2. Un module ne peut importer l'API publique d'un autre module que si le graphe
//      l'y autorise explicitement (MODULE_GRAPH ci-dessous).
//
// `platform` et `audit` sont omis du graphe : tout module métier en dispose
// (03-graphe-dependances.md, note sous le diagramme) ; ils sont donc toujours autorisés.

/** Dépendances autorisées par module métier, hors `platform` et `audit` (toujours permis). */
const MODULE_GRAPH = {
  identity: ['organization'],
  organization: [], // références universelles à identity.users/devices : tables, pas de code
  approvals: ['identity', 'organization', 'attachments'],
  attachments: ['identity'],
  catalog: ['identity'],
  fieldwork: ['identity', 'organization', 'approvals'],
  crm: ['identity', 'organization', 'catalog', 'fieldwork', 'approvals', 'attachments'],
  pricing: ['identity', 'organization', 'catalog'],
  inventory: ['identity', 'organization', 'catalog', 'approvals', 'attachments'],
  procurement: ['identity', 'organization', 'catalog', 'approvals', 'attachments', 'inventory'],
  production: [
    'identity',
    'organization',
    'catalog',
    'approvals',
    'attachments',
    'inventory',
    'procurement',
  ],
  finance: [
    'identity',
    'organization',
    'catalog',
    'approvals',
    'attachments',
    'inventory',
    'procurement',
  ],
  sales: [
    'identity',
    'organization',
    'catalog',
    'approvals',
    'attachments',
    'crm',
    'fieldwork',
    'pricing',
    'inventory',
    'finance',
  ],
  communication: ['identity', 'organization'],
  sync: ['identity'],
  analytics: ['identity'],
  integrations: ['identity', 'crm'], // + lecture de sales, exprimée à part (accès en lecture seule)
};

const ALL_MODULES = Object.keys(MODULE_GRAPH);

/** Une règle « forbidden » par module : interdit d'importer les modules non autorisés. */
const graphRules = ALL_MODULES.map((mod) => {
  const allowed = new Set([mod, 'platform', 'audit', ...MODULE_GRAPH[mod]]);
  const forbidden = ALL_MODULES.filter((m) => !allowed.has(m));
  if (forbidden.length === 0) return null;
  return {
    name: `graph-${mod}`,
    severity: 'error',
    comment:
      `Le module '${mod}' n'a pas le droit d'importer ${forbidden.join(', ')} ` +
      `(hors graphe de dépendances, 03-graphe-dependances.md).`,
    from: { path: `^apps/server/src/modules/${mod}/` },
    to: { path: `^apps/server/src/modules/(${forbidden.join('|')})/` },
  };
}).filter(Boolean);

// Une règle par module (comme graphRules) plutôt qu'une règle générique avec `pathNot:
// ['^apps/server/src/modules/\\1/']` : dependency-cruiser ne réutilise pas, dans `to`, un
// groupe capturé par le pattern de `from` (chaque pattern est évalué indépendamment) — la
// version générique ne s'auto-exemptait donc jamais réellement (bloquait tout import d'un
// module vers son *propre* dossier api/domain/infrastructure/application, découvert dès le
// premier module réel construit sous apps/server/src/modules/, P0-06/identity). En excluant
// `mod` lui-même de la liste des « autres modules » ciblés par `to`, l'auto-import n'est
// même plus dans le champ de la règle, sans dépendre d'un mécanisme de référence croisée.
const publicApiOnlyRules = ALL_MODULES.map((mod) => {
  const others = ALL_MODULES.filter((m) => m !== mod);
  if (others.length === 0) return null;
  return {
    name: `module-public-api-only-${mod}`,
    severity: 'error',
    comment:
      `Le module '${mod}' n'importe que l'API publique (application/public) d'un autre ` +
      'module : jamais son domaine interne, son infrastructure ou son adaptateur HTTP ' +
      '(01-architecture-logicielle.md §3, règle 1).',
    from: { path: `^apps/server/src/modules/${mod}/` },
    to: {
      path: `^apps/server/src/modules/(${others.join('|')})/(api|domain|infrastructure|application)/`,
      pathNot: [`^apps/server/src/modules/(${others.join('|')})/application/public/`],
    },
  };
}).filter(Boolean);

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Le graphe de dépendances entre modules est acyclique par construction.',
      from: {},
      to: { circular: true },
    },
    ...publicApiOnlyRules,
    ...graphRules,
    {
      name: 'no-sync-core-business-logic',
      severity: 'error',
      comment:
        "`sync` ne contient aucune règle de domaine (02-modules.md §17) : c'est un registre, " +
        "les modules métier s'y enregistrent, il ne les appelle jamais directement.",
      from: { path: '^apps/server/src/platform/sync/' },
      to: { path: '^apps/server/src/modules/(?!platform)' },
    },
    {
      name: 'domain-package-no-io',
      severity: 'error',
      comment:
        'packages/domain est une bibliothèque métier pure, sans accès réseau ni base ' +
        "(05-stack.md §2.1) : elle ne dépend d'aucun package applicatif.",
      from: { path: '^packages/domain/src/' },
      to: { path: '^(apps/|packages/contracts/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
