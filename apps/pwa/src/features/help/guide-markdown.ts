/**
 * Guide écrit de l'application (AV-525, ADR-058) : le même contenu que le panneau « Aide » de chaque page et
 * que l'écran « Guide et aide », mis en forme pour `docs/11-guide-utilisateur/01-guide-global.md`. Fonction
 * pure : l'essai `guide-doc.test.ts` compare son résultat au fichier commité, et le réécrit sur demande
 * (`GIC_WRITE_GUIDE=1`). Ne rien modifier à la main dans le fichier : on corrige le contenu, puis on le génère.
 */
import { SCREEN_GROUPS, SCREENS } from '../../app/screens.js';
import { FAQ, JOURNEYS, SCREEN_HELP } from './content/index.js';
import { ROLE_LABELS, type HelpAction, type ScreenHelp } from './help-types.js';
import { rolesOfScreen } from './help-logic.js';

/** Titres des domaines (`nav.groups` de `fr.ts`), dans l'ordre du menu. */
const GROUP_TITLES: Readonly<Record<string, string>> = {
  sales: 'Ventes',
  stock: 'Stock',
  crm: 'Clients',
  procurement: 'Achats',
  production: 'Production',
  finance: 'Finance',
  general: 'Général',
};

/** Abréviations des rôles de la matrice des droits (`07-security-rbac/01-rbac.md` §5). */
const ROLE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  DIRECTION: 'DIR',
  ADMIN: 'ADM',
  RESP_COMMERCIAL: 'RCO',
  COMMERCIAL_TERRAIN: 'CTE',
  COMMERCIAL_SEDENTAIRE: 'CSE',
  VENDEUR_PDV: 'VEN',
  RESP_PRODUCTION: 'RPR',
  RESP_FERME: 'RFE',
  MAGASINIER: 'MAG',
  RESP_ACHATS: 'ACH',
  FINANCE: 'FIN',
  SUPERVISION: 'SUP',
};

const ROLE_CODES = Object.keys(ROLE_ABBREVIATIONS);

const rolesText = (roles: readonly string[] | 'ALL'): string =>
  roles === 'ALL' ? 'tous' : roles.map((role) => ROLE_LABELS[role] ?? role).join(', ');

/** Le texte d'une cellule de tableau : sans retour à la ligne ni barre verticale. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function actionsTable(page: ScreenHelp, screenRoles: readonly string[] | 'ALL'): string[] {
  const rows = page.actions.map((action: HelpAction) => {
    const who = action.roles ?? screenRoles;
    return `| ${cell(action.label)} | ${cell(action.what)} | ${cell(rolesText(who))} | ${
      action.online ? 'en ligne' : '—'
    } |`;
  });
  return ['| Action | Ce qu’elle fait | Qui | Réseau |', '|---|---|---|---|', ...rows];
}

function pageSection(page: ScreenHelp, level: string): string[] {
  const screen = SCREENS.find((candidate) => candidate.path === page.path);
  const roles = rolesOfScreen(page);
  const lines = [
    `${level} ${page.title}`,
    '',
    `\`${page.path}\`${screen ? ` · ${screen.id}` : ''} · ${
      roles === 'ALL' ? 'tous les profils' : rolesText(roles)
    }${screen ? (screen.offline ? ' · utilisable hors ligne' : ' · en ligne') : ''}`,
    '',
    page.purpose,
    '',
  ];
  if (page.before && page.before.length > 0) {
    lines.push('**Avant de commencer**', '', ...page.before.map((line) => `- ${line}`), '');
  }
  lines.push(...actionsTable(page, roles), '');
  if (page.next && page.next.length > 0) {
    lines.push(
      '**Ensuite**',
      '',
      ...page.next.map((link) => `- ${link.label} (\`${link.to}\`) — ${link.why}`),
      '',
    );
  }
  return lines;
}

export function renderGuideMarkdown(): string {
  const out: string[] = [
    '# Guide de l’application GIC AGROPELC',
    '',
    '> **Généré** à partir du contenu de l’aide de l’application (`apps/pwa/src/features/help/content/`) : c’est le même texte que le bouton « ? » de chaque page et que l’écran « Guide et aide ». Ne le modifiez pas à la main : corrigez le contenu, puis régénérez avec `GIC_WRITE_GUIDE=1 pnpm --filter @gic/pwa exec vitest run src/features/help/guide-doc.test.ts`. Un essai échoue tant que ce fichier n’est pas à jour.',
    '',
    '## 1. Comment lire ce guide',
    '',
    '- **Chaque page de l’application a son aide** : le bouton « ? » en haut de l’écran dit à quoi sert la page, ce que votre profil peut y faire, ce qui demande un autre rôle (et lequel), ce qu’il faut avoir fait avant et l’étape suivante.',
    '- **Les droits dépendent du rôle** : un compte reçoit un ou plusieurs rôles ; un rôle de terrain (responsable de ferme, magasinier, vendeur) est rattaché à un site. Une page ou un bouton absent veut dire « votre rôle ne porte pas cette fonction », pas « la fonction n’existe pas ».',
    '- **Rien ne se supprime** : on corrige par annulation motivée ; l’historique reste.',
    '- **Hors ligne** : la plupart des saisies du terrain restent sur le téléphone et partent au retour du réseau ; l’administration, la finance, l’analyse, la clôture d’un lot et les annulations demandent le réseau.',
    '',
    '### Les rôles',
    '',
    '| Code | Rôle |',
    '|---|---|',
    ...ROLE_CODES.map((code) => `| ${ROLE_ABBREVIATIONS[code]} | ${ROLE_LABELS[code]} |`),
    '',
    '## 2. Les parcours de bout en bout',
    '',
  ];

  for (const journey of JOURNEYS) {
    out.push(
      `### ${journey.title}`,
      '',
      journey.goal,
      '',
      `*Écrit pour : ${rolesText(journey.roles)}.*`,
      '',
      '| # | Étape | Page | Qui | Ce qu’on y fait |',
      '|---|---|---|---|---|',
    );
    journey.steps.forEach((step, index) => {
      const screen = SCREENS.find((candidate) => candidate.path === step.to);
      const who = step.roles ?? screen?.roles ?? 'ALL';
      out.push(
        `| ${index + 1} | ${cell(step.label)} | \`${step.to}\` | ${cell(rolesText(who))} | ${cell(step.what)} |`,
      );
    });
    out.push('');
  }

  out.push('## 3. Les pages, par domaine', '');
  for (const group of SCREEN_GROUPS) {
    const pages = SCREEN_HELP.filter(
      (help) => SCREENS.find((screen) => screen.path === help.path)?.group === group,
    );
    if (pages.length === 0) continue;
    out.push(`### ${GROUP_TITLES[group] ?? group}`, '');
    for (const page of pages) out.push(...pageSection(page, '####'));
  }

  const details = SCREEN_HELP.filter(
    (help) => !SCREENS.some((screen) => screen.path === help.path),
  );
  out.push('### Pages de détail', '');
  for (const page of details) out.push(...pageSection(page, '####'));

  out.push('## 4. Questions fréquentes', '');
  for (const item of FAQ) out.push(`**${item.question}**`, '', item.answer, '');

  out.push(
    '## Annexe A — Quelles pages pour quel rôle',
    '',
    `Une croix indique que le menu propose la page au rôle. Le serveur revérifie chaque permission. Abréviations : ${ROLE_CODES.map(
      (code) => `${ROLE_ABBREVIATIONS[code]} = ${ROLE_LABELS[code]}`,
    ).join(', ')}.`,
    '',
    `| Page | ${ROLE_CODES.map((code) => ROLE_ABBREVIATIONS[code]).join(' | ')} |`,
    `|---|${ROLE_CODES.map(() => ':-:').join('|')}|`,
  );
  for (const group of SCREEN_GROUPS) {
    for (const screen of SCREENS.filter((candidate) => candidate.group === group)) {
      const help = SCREEN_HELP.find((candidate) => candidate.path === screen.path);
      const title = help ? help.title : screen.path;
      const marks = ROLE_CODES.map((code) =>
        screen.roles === 'ALL' || screen.roles.includes(code) ? '×' : '',
      );
      out.push(`| ${cell(title)} (\`${screen.path}\`) | ${marks.join(' | ')} |`);
    }
  }
  out.push('');

  return out.join('\n');
}
