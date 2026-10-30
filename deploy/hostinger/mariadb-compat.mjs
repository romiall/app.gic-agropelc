/**
 * Compatibilite MariaDB de l'hebergement (Hostinger : MariaDB 11.8 ; l'application vise MySQL 8.4).
 *
 * Deux constructions du code serveur n'existent pas en MariaDB et font echouer la requete (erreur 1064) :
 *   - CAST(? AS JSON)  -> JSON_EXTRACT(?, '$')   : toute ecriture d'une colonne JSON (audit, evenements, journal des
 *                                                  commandes, taches, alertes...) passe par `jsonValue()` ;
 *   - FOR SHARE        -> LOCK IN SHARE MODE     : toutes les lectures verrouillantes en partage (`.forShare()`).
 * Elles sont reecrites au moment ou Kysely compile la requete : le code source et son comportement sous MySQL 8.4
 * ne changent pas (la suite d'essais n'est pas concernee). Les semis, eux, sont adaptes a la construction du paquet
 * (build-bundle.ps1), et les migrations par migrate.mjs.
 *
 * Le compilateur est passe en argument (au lieu d'importer 'kysely' ici) : le meme module sert au serveur (server.js)
 * et au test local (test-mariadb-compat.mjs), qui doivent partager la meme instance de Kysely.
 * A installer AVANT la creation de l'application : le compilateur retient ses methodes a sa construction.
 */

// Les chaines de remplacement sont rendues par des fonctions : '$' y serait sinon un motif special de String.replace.
const CAST_JSON_LITERAL = /CAST\(\s*\?\s+AS\s+JSON\s*\)/gi;
const CAST_JSON_OPEN = /CAST\(\s*$/i;
const CAST_JSON_CLOSE = /^\s+AS\s+JSON\s*\)/i;

/**
 * Fragments SQL d'un `sql` de Kysely : le texte entre deux parametres. `CAST(${x} AS JSON)` s'y presente en deux
 * morceaux (l'ouverture finit un fragment, la fermeture commence le suivant) ; `sql.raw('CAST(? AS JSON)')` en un seul.
 * Rend le meme tableau s'il n'y a rien a changer.
 */
export function adaptRawFragments(fragments) {
  const out = fragments.slice();
  let changed = false;
  for (let i = 0; i < out.length; i += 1) {
    const whole = out[i].replace(CAST_JSON_LITERAL, () => "JSON_EXTRACT(?, '$')");
    if (whole !== out[i]) {
      out[i] = whole;
      changed = true;
    }
    if (i + 1 < out.length && CAST_JSON_OPEN.test(out[i]) && CAST_JSON_CLOSE.test(out[i + 1])) {
      out[i] = out[i].replace(CAST_JSON_OPEN, () => 'JSON_EXTRACT(');
      out[i + 1] = out[i + 1].replace(CAST_JSON_CLOSE, () => ", '$')");
      changed = true;
    }
  }
  return changed ? out : fragments;
}

/** Rend true si l'adaptation vient d'etre posee, false si elle l'etait deja. */
export function installMariaDbCompat(DefaultQueryCompiler) {
  const proto = DefaultQueryCompiler.prototype;
  if (Object.prototype.hasOwnProperty.call(proto, '__gicMariaDbCompat')) return false;
  const visitRaw = proto.visitRaw;
  const visitSelectModifier = proto.visitSelectModifier;
  if (typeof visitRaw !== 'function' || typeof visitSelectModifier !== 'function') {
    throw new Error(
      'Compatibilite MariaDB : le compilateur de Kysely a change (visitRaw ou visitSelectModifier absent).',
    );
  }
  proto.visitRaw = function visitRawMariaDb(node) {
    const fragments = adaptRawFragments(node.sqlFragments);
    return visitRaw.call(
      this,
      fragments === node.sqlFragments ? node : { ...node, sqlFragments: fragments },
    );
  };
  proto.visitSelectModifier = function visitSelectModifierMariaDb(node) {
    if (node.modifier === 'ForShare' && !node.rawModifier) {
      this.append('lock in share mode');
      return undefined;
    }
    return visitSelectModifier.call(this, node);
  };
  Object.defineProperty(proto, '__gicMariaDbCompat', { value: true });
  return true;
}
