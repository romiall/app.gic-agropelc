/**
 * Controle statique des scripts PowerShell du kit (deploy/hostinger/*.ps1), sans PowerShell ni reseau :
 *   node deploy/hostinger/test-ps-scripts.mjs
 *
 * 1. Aucun script ne range de valeur dans une variable qui porte le nom d'un de ses parametres. PowerShell ne distingue
 *    pas les majuscules des minuscules : `$strictSql = '0'` ecrase le parametre `[switch]$StrictSql` et echoue a
 *    l'execution (« Impossible de convertir la valeur System.String en type SwitchParameter »). C'est ce qui a arrete la
 *    livraison du 08/11/2026 (commit 4e113e8b) apres la construction et l'envoi du paquet, avant toute mise a jour du
 *    serveur : le defaut n'apparaissait qu'en lancant vraiment le script.
 * 2. Les scripts du kit restent en ASCII (Windows PowerShell 5.1 lit mal l'UTF-8 sans BOM).
 * Fichier ASCII volontairement.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Le texte d'un script sans commentaires ni contenu de chaines : memes longueur et sauts de ligne, donc memes positions
 * (les numeros de ligne restent ceux du fichier).
 */
export function blankNonCode(text) {
  const blank = (part) => part.replace(/[^\r\n]/g, ' ');
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '<' && text[i + 1] === '#') {
      const end = text.indexOf('#>', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (char === '#' && (i === 0 || /[\s;({]/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (char === '"' && text[j] === '`') {
          j += 2;
        } else if (text[j] === char && text[j + 1] === char) {
          j += 2;
        } else if (text[j] === char) {
          break;
        } else {
          j += 1;
        }
      }
      const close = Math.min(j, text.length);
      out += char + blank(text.slice(i + 1, close)) + (close < text.length ? char : '');
      i = close + 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** Bloc `param( ... )` d'un script (code deja nettoye) : { open, close, body }, ou null s'il n'y en a pas. */
export function paramBlock(code) {
  const match = /(^|\n)[ \t]*param[ \t]*\(/i.exec(code);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return { open, close: i, body: code.slice(open + 1, i) };
    }
  }
  return null;
}

/** Contenu d'un segment sans ses groupes entre crochets (types et attributs) : le premier `$nom` restant est le parametre. */
function withoutBrackets(segment) {
  let depth = 0;
  let out = '';
  for (const char of segment) {
    if (char === '[') depth += 1;
    else if (char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

/** Noms des parametres declares dans le corps d'un bloc `param`. */
export function parameterNames(body) {
  const names = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    const found = /\$([A-Za-z_]\w*)/.exec(withoutBrackets(current));
    if (found) names.push(found[1]);
    current = '';
  };
  for (const char of body) {
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) flush();
    else current += char;
  }
  flush();
  return names;
}

/**
 * Variables du script qui portent (sans distinction de casse) le nom d'un de ses parametres et qui recoivent une valeur
 * (`=`, `+=`, ... ou variable d'une boucle foreach). Rend [{ name, parameter, line }].
 */
export function parameterCollisions(source) {
  const code = blankNonCode(source);
  const block = paramBlock(code);
  if (!block) return [];
  const parameters = new Map(parameterNames(block.body).map((name) => [name.toLowerCase(), name]));
  const outside =
    code.slice(0, block.open) +
    code.slice(block.open, block.close + 1).replace(/[^\r\n]/g, ' ') +
    code.slice(block.close + 1);
  const found = [];
  const patterns = [
    /(?:^|[^\w$:.])\$([A-Za-z_]\w*)[ \t]*(?:[-+*/%]|\?\?)?=(?!=)/g,
    /\bforeach[ \t]*\([ \t]*\$([A-Za-z_]\w*)[ \t]+in\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of outside.matchAll(pattern)) {
      const parameter = parameters.get(match[1].toLowerCase());
      if (parameter) {
        const line = outside.slice(0, match.index + match[0].indexOf('$')).split('\n').length;
        found.push({ name: match[1], parameter, line });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// --- Essais de la regle sur des exemples ---------------------------------------------------------------------------

// Le defaut de la livraison du 08/11/2026 : la variable locale est le parametre, a la casse pres.
assert.deepEqual(
  parameterCollisions(
    [
      'param([switch]$SkipBuild, [switch]$StrictSql)',
      "$noBackup = if ($SkipBuild) { '1' } else { '0' }",
      "$strictSql = if ($StrictSql) { '1' } else { '0' }",
    ].join('\n'),
  ),
  [{ name: 'strictSql', parameter: 'StrictSql', line: 3 }],
);

// Le correctif : un autre nom.
assert.deepEqual(
  parameterCollisions(
    "param([switch]$StrictSql)\n$sqlStrictFlag = if ($StrictSql) { '1' } else { '0' }\n",
  ),
  [],
);

// Parametres avec attributs, types et valeurs par defaut (parentheses, chaines, crochets).
const withAttributes = [
  'param(',
  '  [Parameter(Mandatory = $true)][string]$ManagerEmail,',
  "  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\\gic (cle)'),",
  '  [int]$Port = 65002,',
  '  [string[]]$Items = @("a", "b")',
  ')',
  '$port = 22',
  '$userprofile = 1',
  '$true = 1',
  '$items += "c"',
  'foreach ($KEYPATH in 1..2) { }',
].join('\n');
assert.deepEqual(
  parameterCollisions(withAttributes).map((c) => [c.parameter, c.line]),
  [
    ['Port', 7],
    ['Items', 10],
    ['KeyPath', 11],
  ],
);

// Ce qui n'est pas du code n'est pas lu : commentaires, chaines, variables a portee et variables d'environnement.
assert.deepEqual(
  parameterCollisions(
    [
      '<#',
      "  $strictSql = 'dans le commentaire d'aide'",
      '#>',
      'param([switch]$StrictSql)',
      '# $strictSql = 1',
      "$text = '$strictSql = 1'",
      '$other = "ligne $strictSql = 1"',
      "$script:strictSql = '1'",
      "$env:StrictSql = '1'",
      'if ($StrictSql -eq $true) { }',
    ].join('\n'),
  ),
  [],
);

// Sans bloc `param` : rien a controler.
assert.deepEqual(parameterCollisions('$x = 1\n$y = 2\n'), []);

// --- Les scripts du kit --------------------------------------------------------------------------------------------

const scripts = readdirSync(HERE)
  .filter((name) => name.endsWith('.ps1'))
  .sort();
assert.ok(scripts.length >= 5, 'scripts PowerShell du kit introuvables : ' + scripts.join(', '));

for (const name of scripts) {
  const raw = readFileSync(path.join(HERE, name));
  assert.ok(
    !raw.some((byte) => byte > 0x7f),
    name + " : caractere non ASCII (Windows PowerShell 5.1 lit mal l'UTF-8 sans BOM)",
  );
  const collisions = parameterCollisions(raw.toString('utf8'));
  assert.deepEqual(
    collisions,
    [],
    name +
      ' : variable nommee comme un parametre (a la casse pres) : ' +
      collisions
        .map((c) => '$' + c.name + ' ligne ' + c.line + ' (parametre $' + c.parameter + ')')
        .join(', '),
  );
}

// Le controle lit bien les vrais scripts (il ne passe pas a vide).
const deployText = readFileSync(path.join(HERE, 'deploy.ps1'), 'utf8');
const deployParameters = parameterNames(paramBlock(blankNonCode(deployText)).body);
for (const expected of ['HostName', 'Port', 'KeyPath', 'SkipBuild', 'BuildOnly', 'StrictSql']) {
  assert.ok(
    deployParameters.includes(expected),
    'parametre ' + expected + ' non lu dans deploy.ps1',
  );
}

console.log('scripts PowerShell du kit (' + scripts.length + ') : tous les essais passent.');
