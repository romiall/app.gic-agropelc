export const meta = {
  name: 'p5-lot1-suite',
  description: 'Suite du lot 1 de P5 en Sonnet : corrections de P5-11, revue de P5-12, implémentation reprise de P5-15 et P5-16, revue adverse, vérification, corrections',
  phases: [
    { title: 'Implémentation', detail: 'reprise du travail partiel de P5-15 et P5-16', model: 'sonnet' },
    { title: 'Revue', detail: 'trois relecteurs adverses par incrément', model: 'sonnet' },
    { title: 'Vérification', detail: 'un sceptique par défaut signalé', model: 'sonnet' },
    { title: 'Correction', detail: 'corrections des défauts confirmés, tests, commit', model: 'sonnet' },
  ],
}

const BASE = args.baseCommit
const LOTS = args.lots
const IN = args.inputsDir
function inFile(name) {
  return IN + '\\' + name
}
// Une entrée est soit un objet (inclus en JSON), soit le chemin d'un fichier JSON à lire.
function payload(x) {
  return typeof x === 'string' ? 'lis en entier le fichier JSON ' + x + ' (outil Read)' : JSON.stringify(x)
}

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    requirements: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, statement: { type: 'string' }, classe: { type: 'string' }, source: { type: 'string' }, testPlan: { type: 'string' } },
      required: ['id', 'statement', 'classe', 'source', 'testPlan'] } },
    behaviours: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'object', properties: {
      path: { type: 'string' }, action: { type: 'string' }, purpose: { type: 'string' } }, required: ['path', 'action', 'purpose'] } },
    migration: { type: 'string' },
    seeds: { type: 'string' },
    tests: { type: 'array', items: { type: 'object', properties: {
      file: { type: 'string' }, cases: { type: 'array', items: { type: 'string' } } }, required: ['file', 'cases'] } },
    docs: { type: 'array', items: { type: 'object', properties: {
      path: { type: 'string' }, change: { type: 'string' } }, required: ['path', 'change'] } },
    avCandidates: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, question: { type: 'string' }, defaultChoice: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'question', 'defaultChoice', 'why'] } },
    sharedFiles: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'requirements', 'behaviours', 'files', 'migration', 'seeds', 'tests', 'docs', 'avCandidates', 'sharedFiles', 'risks', 'outOfScope'],
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    issues: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['BLOQUANT', 'MAJEUR', 'MINEUR'] },
      title: { type: 'string' }, detail: { type: 'string' }, source: { type: 'string' }, correction: { type: 'string' } },
      required: ['severity', 'title', 'detail', 'source', 'correction'] } },
  },
  required: ['issues'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', properties: {
      command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    checks: { type: 'object', properties: {
      typecheck: { type: 'string' }, lint: { type: 'string' }, boundaries: { type: 'string' }, prettier: { type: 'string' }, checkRefs: { type: 'string' } },
      required: ['typecheck', 'lint', 'boundaries', 'prettier', 'checkRefs'] },
    avCreated: { type: 'array', items: { type: 'string' } },
    adrCreated: { type: 'array', items: { type: 'string' } },
    migrations: { type: 'array', items: { type: 'string' } },
    permissionsAdded: { type: 'array', items: { type: 'string' } },
    codesAdded: { type: 'array', items: { type: 'string' } },
    sharedFilesTouched: { type: 'array', items: { type: 'string' } },
    critiqueRejected: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['committed', 'commits', 'summary', 'filesChanged', 'testsRun', 'checks', 'avCreated', 'adrCreated', 'migrations', 'permissionsAdded', 'codesAdded', 'sharedFilesTouched', 'critiqueRejected', 'openIssues'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, severity: { type: 'string', enum: ['CRITIQUE', 'MAJEUR', 'MINEUR'] },
      file: { type: 'string' }, line: { type: 'number' }, scenario: { type: 'string' }, evidence: { type: 'string' }, suggestedFix: { type: 'string' } },
      required: ['title', 'severity', 'file', 'scenario', 'evidence', 'suggestedFix'] } },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    correctedSeverity: { type: 'string', enum: ['CRITIQUE', 'MAJEUR', 'MINEUR', 'AUCUNE'] },
    reason: { type: 'string' },
  },
  required: ['real', 'correctedSeverity', 'reason'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, how: { type: 'string' } }, required: ['title', 'how'] } },
    notFixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'why'] } },
    commits: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    checks: { type: 'string' },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'notFixed', 'commits', 'testsRun', 'checks', 'openIssues'],
}

function others(lot) {
  return LOTS.filter((l) => l.id !== lot.id).map((l) => l.id + ' (' + l.title + ')').join(' ; ')
}

function common(lot) {
  return [
    'CADRE COMMUN (à respecter strictement)',
    '- Projet GIC AGROPELC ; les règles de CLAUDE.md s\'appliquent. Documentation, rapports et messages de commit en français.',
    '- Tu travailles UNIQUEMENT dans le worktree ' + lot.dir + ' (branche locale ' + lot.branch + ', créée depuis le commit ' + BASE + ' de claude/brave-pasteur-c7q4y7). Chemin sous Bash : ' + lot.bash + '. Tout chemin de fichier que tu lis ou écris commence par ' + lot.dir + '. Chaque commande Bash commence par « cd ' + lot.bash + ' && ». Ne modifie JAMAIS la copie principale C:\\xampp\\htdocs\\app.gic-agropelc (hors de ton worktree) ni un autre worktree.',
    '- Base de données : uniquement la tienne, ' + lot.db + ' (MySQL 8.4, port 3307, migrée et semée). Le db/.env du worktree pointe dessus : « set -a; . db/.env; set +a » depuis la racine du worktree. Interdits : les bases gic_agropelc_test, gic_agropelc_dev, gic_agropelc_base et celles des autres lots ; DROP DATABASE ; décaler l\'horloge d\'un test vers le futur ; afficher ou écrire un mot de passe.',
    '- Incréments menés EN PARALLÈLE par d\'autres agents (ne fais pas leur travail) : ' + others(lot) + '. Incréments ultérieurs, hors de ton périmètre : P5-13, P5-14, P5-17 à P5-24 (voir le plan §4).',
    '- Identifiants réservés à ton lot : ' + lot.av + ' (points AV, à créer seulement si nécessaire, dans l\'ordre) ; ' + lot.adr + ' seulement si une décision structurante l\'exige ; version de migration ' + lot.migration + ' (puis +100 par migration supplémentaire). N\'utilise aucun autre numéro.',
    '- Ne modifie pas : CLAUDE.md, PROMPT-DE-REPRISE.md, la ligne de ton incrément dans docs/10-development-plan/01-plan-developpement.md (l\'intégrateur marque l\'état). Tout le reste du référentiel touché par ton incrément (domaines Dnn, dictionnaire des tables, SM-*, WF-*, BR-*, INV-*, matrice de traçabilité, A-VALIDER, catalogue d\'événements, matrice des conflits, protocole de synchronisation, RBAC) se met à jour dans le même commit que le code.',
    '- Aucune question à l\'utilisateur n\'est possible : une question métier non couverte devient un point AV (question, pourquoi, choix, recommandation, impact, classe) et la valeur par défaut recommandée est implémentée de façon paramétrable (CLAUDE.md règle 2). Classe chaque affirmation (CONFIRMÉ / DÉDUIT / À VALIDER) ; aucun seuil métier codé en dur.',
    '- À ignorer totalement : fiches-terrain/, le fichier « historique conversation », quickstart.sh, .claude/.',
  ].join('\n')
}

function tech(lot) {
  return [
    'COMMANDES (depuis la racine du worktree, après « set -a; . db/.env; set +a »)',
    '- Avant tout : vérifie que l\'environnement est prêt (node_modules/.modules.yaml et packages/domain/dist/index.js présents ; base : SELECT COUNT(*) FROM ' + lot.db + '.schema_migrations doit valoir au moins 46). S\'il ne l\'est pas, attends en revérifiant (boucle de vérification dans une seule commande, au plus 10 minutes) ; si l\'attente échoue, arrête-toi et signale-le dans openIssues.',
    '- MySQL 8.4 (port 3307) s\'arrête parfois sur ce poste ; d\'autres agents l\'utilisent en même temps. S\'il ne répond plus (« Can\'t connect … 3307 »), vérifie d\'abord par « \"/c/Program Files/MySQL/MySQL Server 8.4/bin/mysqladmin.exe\" -h127.0.0.1 -P3307 -uping_only ping » (« Access denied » = il tourne), puis relance-le en processus détaché par l\'outil PowerShell : Start-Process -FilePath \"C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqld.exe\" -ArgumentList \'--defaults-file=\"C:\\Users\\SMART\\mysql84\\my.ini\"\' -WindowStyle Hidden ; attends qu\'il réponde (jusqu\'à 2 minutes). Jamais le MySQL de XAMPP (port 3306), jamais « mysqld --console » en tâche de fond.',
    '- Domaine : « cd packages/domain && npx vitest run --coverage » (couverture ≥ 90 %, NFR-31). Reconstruis « pnpm --filter @gic/domain run build » (et « pnpm --filter @gic/contracts run build ») dès qu\'un export change, avant le typage du serveur.',
    '- Serveur : « cd apps/server && npx vitest run test/<fichier> ». Lance les fichiers que tu crées ET tous les fichiers de test des modules que tu touches (filtre par préfixe, ex. « npx vitest run test/sales- »). Chaque commande doit tenir sous 10 minutes (découpe sinon). La suite complète sera relancée par l\'intégrateur. Le poste est partagé et chargé : un dépassement de délai isolé se confirme en relançant le fichier seul.',
    '- Base : « cd db && npx vitest run » si tu modifies des migrations ou des seeds.',
    '- Migration : fichier nommé à la main db/migrations/<version>_<nom>.sql (transaction:false, up et down), appliqué par « cd db && npx dbmate --migrations-dir ./migrations --schema-file ./schema.sql --no-dump-schema up » ; db/schema.sql mis à jour à la main (mysqldump --no-data --triggers --skip-add-drop-table des tables créées ou modifiées, DEFINER remplacé par `gic_migrator`@`%`, bloc à sa place alphabétique, version ajoutée en fin de liste schema_migrations ; jamais « dbmate dump ») ; types Kysely : « cd apps/server && npx kysely-codegen --dialect mysql --url \"$DATABASE_URL\" --out-file src/platform/kysely/schema.generated.ts ». Clients MySQL : \"/c/Program Files/MySQL/MySQL Server 8.4/bin/mysql.exe\" (et mysqldump.exe), mot de passe passé par la variable MYSQL_PWD extraite de DATABASE_URL, jamais en clair. SQL compatible MySQL 8.0 (CI). Une migration qui modifie une contrainte CHECK à liste de valeurs partagée doit être signalée dans sharedFilesTouched.',
    '- Seeds : « cd db && npx tsx seeds/run.ts » après modification ; mets à jour les assertions de db/tests/seed.test.ts.',
    '- Contrôles avant commit : « pnpm run typecheck » ; « npx eslint <fichiers modifiés> » ; « pnpm run check:boundaries » ; Prettier : « npx prettier --check <fichiers> » — la copie de travail est en CRLF (core.autocrlf) et Prettier peut signaler un fichier dont seules les fins de ligne diffèrent : confirme par « npx prettier <f> | diff --strip-trailing-cr <f> - » (aucune sortie = conforme) ; « python docs/_tools/check_refs.py » doit afficher « aucune référence orpheline » et « aucun lien relatif cassé » ; « python docs/_tools/check_refs.py --index » si tu ajoutes ou modifies une règle (ne commite pas une réécriture CRLF sans vraie différence).',
    '- Pièges : lis PROMPT-DE-REPRISE.md §1 « Pièges connus » (politiques et paramètres face à la date réelle : withoutActivePolicies, neutralizePolicy, politique de test bornée par validTo ; paramètres immuables). Toute erreur SQL non métier est rejouée sans fin : valide en code avant tout CHECK ou déclencheur. Un fait accompli hors ligne n\'est jamais rejeté pour une raison d\'état métier (BR-SYN-007). Frontières : un module n\'importe que application/public des modules de niveau inférieur (.dependency-cruiser.cjs). Les avertissements rejoignent WARNING_CODES dans l\'incrément qui les produit (R8).',
    '- Commit : local uniquement, sur ta branche, fichiers nommés explicitement (jamais « git add -A » ni « git add . »), jamais de push. Message en français préfixé par la portée (' + lot.scopePrefix + '), suivi d\'une ligne vide puis de la ligne « Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com> ».',
  ].join('\n')
}

function designPrompt(lot) {
  return [
    common(lot),
    '',
    'MISSION (LECTURE SEULE : ne crée ni ne modifie aucun fichier, ne lance aucun test) — concevoir l\'incrément ' + lot.id + ' du backlog P5.',
    'Fiche de l\'incrément (plan §4, P5) : « ' + lot.scope + ' »',
    'Contexte connu : ' + lot.notes,
    '',
    '1. Lis dans le worktree, dans cet ordre : docs/README.md, docs/00-reference/00-conventions.md, docs/10-development-plan/06-passage-au-developpement.md (règles R1 à R11), la fiche P5 et tout son backlog dans docs/10-development-plan/01-plan-developpement.md §4, les lignes P5 de docs/10-development-plan/02-matrice-tracabilite.md, ADR-032 et ADR-033 (docs/decisions/), puis chaque document que la fiche et la matrice citent pour ton incrément (domaines docs/01-functional/domaines/Dnn, dictionnaire docs/03-data/dictionnaire/, SM-*, WF-*, BR-*, INV-*, AT-*, docs/07-security-rbac/01-rbac.md, matrice des conflits, protocole de synchronisation, et dans docs/A-VALIDER.md les AV cités, notamment AV-153 à AV-165).',
    '2. Lis « git -C ' + lot.bash + ' log --stat -14 » pour ce que P5-01 à P5-10 ont livré, puis le code existant que tu vas étendre : modules concernés de apps/server/src/modules, leurs API publiques, packages/domain et packages/contracts, et les tests voisins à prendre comme patron dans apps/server/test.',
    '3. Produis un plan d\'implémentation précis et vérifiable : exigences couvertes (chaque élément de la fiche, avec source, classe et plan de test), comportements exacts (en ligne / hors ligne, conflits et avertissements avec leurs codes, permissions, événements, verrous et ordre de verrouillage, idempotence), fichiers à créer ou modifier, migration éventuelle (ou « aucune »), seeds (ou « aucun »), tests à écrire (fichier, cas, invariants et AT couverts), documents à mettre à jour, AV à créer dans ta plage réservée avec la valeur par défaut, fichiers partagés avec les autres lots que tu devras toucher (sharedFiles), risques, et ce qui est explicitement hors périmètre.',
    'Appuie chaque affirmation sur un fichier lu ; ne suppose aucune API sans l\'avoir lue.',
  ].join('\n')
}

const CRITIC_LENSES = [
  { key: 'specs', text: 'CONFORMITÉ AUX SPÉCIFICATIONS : relis toi-même la fiche de l\'incrément, la matrice, ADR-032/033, les domaines, SM, WF, BR, INV et AT cités, et le registre AV. Signale chaque élément de la fiche absent ou mal couvert du plan, chaque comportement contraire à une source (CM > PM > docs), chaque trou comblé en silence qui devrait être un AV, chaque élément d\'un autre incrément embarqué à tort, chaque test d\'acceptation ou invariant non automatisé.' },
  { key: 'code', text: 'INTÉGRATION AU CODE : vérifie le plan contre le code réel du worktree (signatures exactes des API publiques citées, pipeline de commandes et registre, gabarits de tests, migrations et contraintes existantes, frontières de modules de .dependency-cruiser.cjs, idempotence, hors ligne BR-SYN-007, verrous et ordre de verrouillage, erreurs SQL rejouées sans fin, seeds et permissions). Signale chaque hypothèse fausse sur le code, chaque fichier oublié, chaque risque de régression et chaque recouvrement avec les lots parallèles.' },
]

function critiquePrompt(lot, design, lens) {
  return [
    common(lot),
    '',
    'MISSION (LECTURE SEULE : ne modifie aucun fichier, ne lance aucun test) — critique adverse du plan de l\'incrément ' + lot.id + ', angle ' + lens.text,
    'Fiche de l\'incrément : « ' + lot.scope + ' »',
    'Plan à critiquer (JSON) :',
    payload(design),
    '',
    'Ne signale que des problèmes réels et sourcés (fichier, section ou ligne) avec la correction attendue. Gravité : BLOQUANT (le plan produirait un défaut ou une non-conformité certaine), MAJEUR (manque important), MINEUR (précision). Liste vide si le plan est correct sous cet angle.',
  ].join('\n')
}

function implPrompt(lot, design, issues) {
  return [
    common(lot),
    '',
    tech(lot),
    '',
    'MISSION — implémenter complètement l\'incrément ' + lot.id + ' dans ton worktree : code, tests, documents, contrôles, puis UN commit local « ' + lot.scopePrefix + ' ' + lot.id + ' — <résumé> ».',
    'Fiche de l\'incrément : « ' + lot.scope + ' »',
    'Contexte connu : ' + lot.notes,
    'Plan de conception (JSON, point de départ ; les sources font foi) :',
    payload(design),
    'Critique du plan (JSON) — traite chaque point BLOQUANT et MAJEUR ; si tu en rejettes un après vérification dans les sources, justifie-le dans critiqueRejected :',
    payload(issues),
    '',
    'Exigences de qualité : chaque élément de la fiche est implémenté, testé (tests d\'intégration à travers le vrai pipeline de commandes sur ta base, comme les tests voisins) et documenté ; chaque invariant INV-* touché a au moins un test ; chaque test d\'acceptation de la fiche est automatisé ; les cas hors ligne, rejeu idempotent, concurrence et conflits sont testés. Avance par petites étapes en relançant les tests ; ne termine pas avec des tests rouges : corrige, ou, si un échec est étranger à ton incrément (prouvé en le reproduisant sur le commit ' + BASE + '), signale-le dans openIssues.',
    'Rapport final : remplis exactement le schéma (commits = hash et titre, testsRun = commandes et résultats chiffrés, checks = résultat de chaque contrôle).',
  ].join('\n')
}

const REVIEW_LENSES = [
  { key: 'argent-stock', text: 'ARGENT, STOCK ET INVARIANTS : montants XAF entiers et arrondis, quantités numeric(14,3), registres en partie double (stock, caisse, quotas), contre-écritures au lieu de suppressions, invariants INV-* de la fiche et voisins, valeurs figées, imputations, sommes de contrôle ; tout chemin qui crée ou détruit de l\'argent ou du stock, ou qui laisse un registre incohérent.' },
  { key: 'hors-ligne-concurrence', text: 'HORS LIGNE, IDEMPOTENCE ET CONCURRENCE : rejeu d\'une commande (même command_id), device_seq, faits accomplis hors ligne jamais rejetés pour une raison d\'état (BR-SYN-007), conflits et avertissements attendus, courses entre appareils, verrous et ordre de verrouillage (interblocage), erreurs SQL non métier rejouées sans fin (CHECK, déclencheur, FK), horodatages occurred_at / received_at, fuseau Africa/Douala, tablette partagée.' },
  { key: 'conformite', text: 'CONFORMITÉ ET COMPLÉTUDE : chaque élément de la fiche est implémenté, testé et documenté ; comportements conformes aux sources (CM, PM, ADR-032/033, domaines, SM, WF, BR, AT) ; documents à jour dans le même commit (dictionnaire, matrice, A-VALIDER, SM, WF, BR, catalogue d\'événements, matrice des conflits, RBAC) ; frontières de modules ; seuils paramétrés ; aucun trou comblé en silence ; tests qui prouvent réellement ce qu\'ils prétendent (assertions présentes, pas de faux vert).' },
]

function reviewPrompt(lot, impl, lens) {
  return [
    common(lot),
    '',
    'MISSION (LECTURE SEULE : ne modifie aucun fichier, ne lance aucun test, ne fais que des SELECT sur ta base si utile) — revue adverse de l\'incrément ' + lot.id + ', angle ' + lens.text,
    'Fiche de l\'incrément : « ' + lot.scope + ' »',
    'Le travail à relire est le diff « git -C ' + lot.bash + ' diff ' + BASE + '..HEAD » (lis aussi le code environnant et les sources citées). Rapport du développeur (JSON) :',
    payload(impl),
    '',
    'Ne signale que des défauts réels avec un scénario concret (entrées, état, résultat fautif) et une preuve (fichier et ligne). Gravité : CRITIQUE (argent ou stock faux, perte de données, rejeu infini, sécurité), MAJEUR (non-conformité à une source, cas non traité, test manquant pour un élément de la fiche), MINEUR. Liste vide si rien de réel.',
  ].join('\n')
}

function verifyPrompt(lot, finding) {
  return [
    'MISSION (LECTURE SEULE : ne modifie aucun fichier, ne lance aucun test) — contre-vérification sceptique d\'un défaut signalé sur l\'incrément ' + lot.id + ' du projet GIC AGROPELC.',
    'Worktree : ' + lot.dir + ' (Bash : ' + lot.bash + '), diff à relire : « git -C ' + lot.bash + ' diff ' + BASE + '..HEAD ». Base de données du lot (SELECT seulement) : ' + lot.db + ' via db/.env du worktree.',
    'Défaut signalé (JSON) :',
    JSON.stringify(finding),
    '',
    'Essaie de le RÉFUTER : relis le code exact et les sources (docs/) et déroule le scénario pas à pas. real = true seulement si le scénario mène vraiment au résultat fautif dans le code actuel, ou si une exigence écrite n\'est réellement pas satisfaite ; sinon real = false. Donne la gravité corrigée et la raison précise (fichiers et lignes).',
  ].join('\n')
}

function fixPrompt(lot, impl, confirmed) {
  return [
    common(lot),
    '',
    tech(lot),
    '',
    'MISSION — corriger dans ton worktree les défauts CONFIRMÉS par la revue adverse de l\'incrément ' + lot.id + ', avec un test de non-régression par défaut quand c\'est possible, mettre à jour les documents concernés, relancer les tests des modules touchés et les contrôles, puis UN commit local « ' + lot.scopePrefix.replace('feat', 'fix') + ' ' + lot.id + ' — corrections de la revue adverse ».',
    'Rapport initial du développeur (JSON) :',
    payload(impl),
    'Défauts confirmés (JSON, avec le verdict du vérificateur) :',
    payload(confirmed),
    '',
    'Si un défaut se révèle faux en le corrigeant, ne le corrige pas et explique-le dans notFixed. Ne termine pas avec des tests rouges.',
  ].join('\n')
}

// Reprise : les agents déjà terminés (args.keepOpus, motifs exacts ou préfixes terminés par *) gardent
// prompt et options à l'identique pour être rejoués depuis le cache ; tout agent qui (re)part tourne en
// Sonnet 5.5 (consigne du porteur du 10/10/2026) avec une note de reprise.
const KEEP = args.keepOpus || []
const RESUME_PARTIAL = args.resumePartial || []
function isKept(label) {
  return KEEP.some((p) => (p.endsWith('*') ? label.startsWith(p.slice(0, -1)) : label === p))
}
function runNote(lot, opts) {
  const lines = [
    'NOTES DE REPRISE (prioritaires)',
    '- N\'affiche jamais le contenu de db/.env ni d\'aucun fichier .env (pas de cat, sed, grep, head sur ces fichiers) : charge-les par « set -a; . db/.env; set +a » et n\'affiche que des noms de variables, jamais de valeur.',
    '- Le dossier temporaire (scratchpad) de la session est partagé avec les autres agents : écris tes scripts et fichiers temporaires uniquement dans un sous-dossier privé nommé d\'après ton lot et ton rôle (ex. scratchpad/' + lot.id.toLowerCase() + '-' + opts.phase.toLowerCase() + '/), jamais à sa racine, et vérifie par git diff que tes modifications ont bien été appliquées.',
  ]
  if (opts.phase === 'Implémentation' && RESUME_PARTIAL.includes(lot.id)) {
    lines.push('- Une tentative précédente de cette implémentation a été interrompue par une limite de quota : le worktree contient son travail partiel NON commité (git status, git diff, fichiers non suivis). Commence par l\'examiner en entier ; reprends-le et termine-le plutôt que de repartir de zéro, en le vérifiant comme ton propre travail (il peut être incomplet ou incohérent). Ta base ' + lot.db + ' peut déjà porter sa migration (SELECT version FROM schema_migrations) et des données de test des essais précédents.')
  }
  return lines.join('\n')
}
function run(lot, prompt, opts) {
  if (isKept(opts.label)) return agent(prompt, opts)
  return agent(prompt + '\n\n' + runNote(lot, opts), { ...opts, model: 'sonnet' })
}

const results = await pipeline(
  LOTS,
  async (lot) => {
    if (lot.start !== 'impl') return { impl: inFile(lot.id + '-implementation.json'), committed: true }
    const impl = await run(lot, implPrompt(lot, inFile(lot.id + '-conception.json'), inFile(lot.id + '-critique.json')), { label: 'implémentation:' + lot.id, phase: 'Implémentation', schema: IMPL_SCHEMA })
    log(lot.id + ' : implémentation ' + (impl && impl.committed ? 'commitée ' + impl.commits.join(', ') : 'NON commitée'))
    return { impl, committed: !!(impl && impl.committed) }
  },
  async (prev, lot) => {
    if (!prev || !prev.committed) return prev
    if (lot.start === 'fix') return { ...prev, confirmed: inFile(lot.id + '-defauts-confirmes.json'), confirmedCount: lot.confirmedCount }
    const reviews = await parallel(REVIEW_LENSES.map((lens) => () =>
      run(lot, reviewPrompt(lot, prev.impl, lens), { label: 'revue:' + lot.id + ':' + lens.key, phase: 'Revue', schema: REVIEW_SCHEMA, effort: 'high' })
        .then((r) => (r ? r.findings.map((f) => ({ ...f, lens: lens.key })) : null))))
    const failedReviews = reviews.filter((r) => r === null).length
    const findings = reviews.filter(Boolean).flat()
    const verdicts = await parallel(findings.map((f, i) => () =>
      run(lot, verifyPrompt(lot, f), { label: 'vérif:' + lot.id + ':' + (i + 1), phase: 'Vérification', schema: VERDICT_SCHEMA, effort: 'high' })
        .then((v) => ({ finding: f, verdict: v }))))
    const confirmed = verdicts.filter(Boolean).filter((x) => x.verdict && x.verdict.real)
    const unverified = verdicts.filter(Boolean).filter((x) => !x.verdict).length
    const refuted = verdicts.filter(Boolean).filter((x) => x.verdict && !x.verdict.real)
    log(lot.id + ' : revue ' + findings.length + ' signalement(s), ' + confirmed.length + ' confirmé(s)' + (failedReviews ? ', ' + failedReviews + ' relecteur(s) en échec' : '') + (unverified ? ', ' + unverified + ' non vérifié(s)' : ''))
    return { ...prev, findings: findings.length, failedReviews, unverified, confirmed, confirmedCount: confirmed.length, refuted: refuted.map((x) => ({ title: x.finding.title, reason: x.verdict.reason })) }
  },
  async (prev, lot) => {
    if (!prev || !prev.confirmed || prev.confirmedCount === 0) return prev
    const fix = await run(lot, fixPrompt(lot, prev.impl, prev.confirmed), { label: 'correction:' + lot.id, phase: 'Correction', schema: FIX_SCHEMA })
    log(lot.id + ' : corrections ' + (fix ? fix.fixed.length + ' faite(s), ' + fix.notFixed.length + ' écartée(s)' : 'agent indisponible'))
    return { ...prev, fix }
  },
)

return LOTS.map((lot, i) => {
  const r = results[i]
  if (!r) return { lot: lot.id, status: 'échec' }
  return {
    lot: lot.id,
    branch: lot.branch,
    start: lot.start,
    impl: typeof r.impl === 'string' ? 'déjà commitée (' + r.impl + ')' : r.impl || null,
    reviewFindings: r.findings,
    failedReviews: r.failedReviews || 0,
    unverified: r.unverified || 0,
    confirmed: Array.isArray(r.confirmed) ? r.confirmed.map((x) => ({ title: x.finding.title, severity: x.verdict.correctedSeverity, lens: x.finding.lens })) : r.confirmed || [],
    refuted: r.refuted || [],
    fix: r.fix || null,
  }
})
