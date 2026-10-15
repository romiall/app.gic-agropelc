/**
 * Aides de calcul et de présentation de l'accueil par rôle (ADR-030) : jours métier (UTC pur sur la
 * chaîne `AAAA-MM-JJ`, le jour métier de Douala étant déjà fixé par `businessDayOf`), montants en
 * français, variations et indicateurs.
 */
import type { HomeKpi, HomeSignal, HomeTone, HomeUnit } from '@gic/contracts';

/** Décale un jour métier de `days` jours (négatif : passé). */
export function shiftDay(day: string, days: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Lundi de la semaine du jour métier (BR-ANA-002 : semaine du lundi au dimanche). */
export function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

/** Les `count` derniers jours métier, du plus ancien au plus récent, `day` compris. */
export function lastDays(day: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => shiftDay(day, index - (count - 1)));
}

/** « 1 250 000 F » : séparateur de milliers insécable, sans décimale (XAF entiers, ADR-013). */
export function formatXaf(value: number): string {
  return `${Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0F`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

export function kpi(input: {
  readonly code: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: HomeUnit;
  readonly detail?: string | null;
  readonly delta?: HomeKpi['delta'];
  readonly series?: HomeKpi['series'];
  readonly tone?: HomeTone;
}): HomeKpi {
  return {
    code: input.code,
    label: input.label,
    value: input.value,
    unit: input.unit,
    detail: input.detail ?? null,
    delta: input.delta ?? null,
    series: input.series ?? null,
    tone: input.tone ?? 'neutral',
  };
}

/**
 * Variation entre deux valeurs d'une même période de comparaison. `upIsGood` : une hausse est
 * favorable (chiffre d'affaires) ou non (créances). Sans valeur de référence (`previous` nul ou
 * absent), aucune variation n'est calculée : un pourcentage sur zéro n'a pas de sens.
 */
export function variation(
  current: number,
  previous: number,
  label: string,
  upIsGood = true,
): HomeKpi['delta'] {
  if (previous <= 0) return null;
  const percent = Math.round(((current - previous) / previous) * 100);
  const direction = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat';
  const tone: HomeTone =
    direction === 'flat' ? 'neutral' : (direction === 'up') === upIsGood ? 'good' : 'bad';
  return {
    label: `${percent > 0 ? '+' : ''}${percent} % ${label}`,
    direction,
    tone,
  };
}

export function signal(input: {
  readonly code: string;
  readonly severity: HomeSignal['severity'];
  readonly title: string;
  readonly detail?: string | null;
  readonly count?: number | null;
  readonly action?: HomeSignal['action'];
}): HomeSignal {
  return {
    code: input.code,
    severity: input.severity,
    title: input.title,
    detail: input.detail ?? null,
    count: input.count ?? null,
    action: input.action ?? null,
  };
}

/**
 * Drapeaux d'une vente (`sales_sales.flags`) : libellés de l'accueil, comme ceux de la PWA. Seul
 * `OUT_OF_SESSION` est informatif (déjà couvert par le signal de prise de service) ; tout autre
 * drapeau, connu ou non, est un contrôle (AV-255).
 */
export const SALE_FLAG_LABELS: Readonly<Record<string, string>> = {
  SESSION_REJECTED: 'Prise de service refusée',
  OUT_OF_SESSION: 'Vente hors prise de service',
  PRICE_MISMATCH: 'Prix différent du catalogue',
  PRODUCT_INACTIVE: 'Produit désactivé',
  ANONYMOUS_UNPAID: 'Vente anonyme non payée',
  CREDIT_OVER_LIMIT: 'Encours du client dépassé',
  STOCK_NEGATIVE: 'Stock devenu négatif',
  LOT_NOT_SELLABLE: 'Lot non vendable',
  PAYMENT_SUSPECT_DUPLICATE: 'Encaissement suspect de doublon',
  CASH_SESSION_MISSING: 'Espèces encaissées sans caisse ouverte',
  ORDER_OVER_FULFILMENT: 'Livraison au-delà de la commande',
  ALLOCATION_EXCEEDED: 'Quota dépassé',
  ALLOCATION_REVOKED_CONSUMED: 'Quota révoqué déjà consommé',
  ALLOCATION_OVERCOMMITTED: 'Quotas au-delà du stock',
  CUSTODY_DEVICE_MISMATCH: 'Stock confié à un autre appareil',
};
export const INFORMATIVE_SALE_FLAGS: ReadonlySet<string> = new Set(['OUT_OF_SESSION']);

/**
 * Types d'anomalie (`sync_sync_conflicts.conflict_type`) : libellés du signal d'accueil (MP-11, revue
 * adverse : le code brut s'affichait en anglais). Repli pour un type inconnu : le code en clair, en
 * minuscules. Mêmes mots que les drapeaux de vente quand le code est le même.
 */
export const CONFLICT_TYPE_LABELS: Readonly<Record<string, string>> = {
  STOCK_NEGATIVE: 'stock devenu négatif',
  CASH_NEGATIVE: 'caisse devenue négative',
  CASH_SESSION_MISSING: 'espèces encaissées sans caisse ouverte',
  CASH_SESSION_CONCURRENT_OPEN: 'caisse ouverte deux fois',
  CASH_SESSION_CONCURRENT_CLOSE: 'caisse fermée deux fois',
  CASH_ACCOUNT_INACTIVE: 'caisse désactivée',
  CASH_SESSION_SITE_CLOSED: 'caisse d’un site fermé',
  CASH_SESSION_CLOSE_BEFORE_MOVEMENTS: 'caisse fermée avant ses mouvements',
  CASH_SESSION_REEVALUATED: 'caisse réévaluée',
  CASH_TRANSFER_RECEIVED_AFTER_CANCEL: 'remise reçue après son annulation',
  CASH_TRANSFER_CANCEL_AFTER_RECEIVE: 'remise annulée après sa réception',
  CASH_TRANSFER_RECEIVED_TWICE: 'remise reçue deux fois',
  CASH_TRANSFER_PAIR_NOT_ALLOWED: 'remise entre caisses non prévue',
  PAYMENT_REFERENCE_DUPLICATE: 'référence de paiement en double',
  PAYMENT_UNALLOCATED: 'encaissement non affecté',
  DUPLICATE_SUSPECTED: 'doublon suspecté',
  DUPLICATE_CUSTOMER: 'client en double',
  PRICE_MISMATCH: 'prix différent du catalogue',
  PRODUCT_INACTIVE: 'produit désactivé',
  ANONYMOUS_UNPAID: 'vente anonyme non payée',
  ORDER_REFUSED_PAYMENT_KEPT: 'commande refusée, acompte conservé',
  ORDER_OVER_FULFILMENT: 'livraison au-delà de la commande',
  VERSION_CONFLICT: 'modification concurrente',
  LOT_CLOSED: 'lot clôturé',
  LOT_NOT_SLAUGHTERABLE: 'lot non abattable',
  LOT_NOT_SELLABLE: 'lot non vendable',
  INCUBATION_BALANCE: 'écart d’incubation',
  TRANSFER_UNMATCHED: 'transfert non rapproché',
  TRANSFER_REQUEST_CLOSED: 'demande de transfert close',
  TRANSFER_OVER_RECEIVED: 'transfert reçu au-delà de l’envoi',
  TRANSFER_RETURN_CONFLICT: 'retour de transfert en conflit',
  TRANSFER_DISPATCH_CONFLICT: 'expédition en conflit',
  OVER_RECEIPT: 'réception au-delà de la commande',
  RECEIPT_PHOTO_MISSING: 'photo du bon de livraison manquante',
  CUSTODY_DEVICE_MISMATCH: 'stock confié à un autre appareil',
  ALLOCATION_RELEASE_MISMATCH: 'restitution de quota en écart',
  ALLOCATION_OVERCOMMITTED: 'quotas au-delà du stock',
  ALLOCATION_REVOKED_CONSUMED: 'quota révoqué déjà consommé',
  ALLOCATION_EXCEEDED: 'quota dépassé',
  SYNC_COMMAND_STALLED: 'opération bloquée à l’envoi',
};

/** Titre du signal des validations en attente ; « Plus de N » au-delà du plafond lu (MP-11). */
export function pendingApprovalsTitle(total: number, truncated: boolean): string {
  const title = plural(total, 'validation vous attend', 'validations vous attendent');
  return truncated ? `Plus de ${title}` : title;
}

export function conflictTypeLabel(type: string): string {
  return CONFLICT_TYPE_LABELS[type] ?? type.replaceAll('_', ' ').toLowerCase();
}

/** Longueur maximale du détail d'un signal (`homeSignalSchema`). */
const SIGNAL_DETAIL_MAX = 240;

/**
 * Ventilation des ventes signalées, « Prix différent du catalogue : 2 · Vente hors prise de service :
 * 3 » : contrôles d'abord, puis du plus fréquent au plus rare ; coupée par « … » au-delà de 240.
 */
export function flaggedSalesDetail(byFlag: ReadonlyMap<string, number>): string {
  const parts = [...byFlag.entries()]
    .sort(
      ([a, countA], [b, countB]) =>
        Number(INFORMATIVE_SALE_FLAGS.has(a)) - Number(INFORMATIVE_SALE_FLAGS.has(b)) ||
        countB - countA ||
        a.localeCompare(b),
    )
    .map(([flag, count]) => `${SALE_FLAG_LABELS[flag] ?? flag} : ${count}`);
  const detail = parts.join(' · ');
  return detail.length <= SIGNAL_DETAIL_MAX
    ? detail
    : `${detail.slice(0, SIGNAL_DETAIL_MAX - 1).trimEnd()}…`;
}

/** Au moins un drapeau de contrôle : le signal est un avertissement, sinon une information (AV-255). */
export function hasControlFlag(byFlag: ReadonlyMap<string, number>): boolean {
  return [...byFlag.keys()].some((flag) => !INFORMATIVE_SALE_FLAGS.has(flag));
}

/**
 * Signal `SALES_FLAGGED` (AV-255) : nombre de ventes signalées, ventilation par cause, avertissement
 * s'il y a un drapeau de contrôle, information si les ventes sont seulement hors prise de service ;
 * lien vers les ventes concernées, route laissée à la PWA (ADR-036). `null` sans vente signalée.
 */
export function flaggedSalesSignal(flagged: {
  readonly salesCount: number;
  readonly byFlag: ReadonlyMap<string, number>;
}): HomeSignal | null {
  if (flagged.salesCount <= 0) return null;
  return signal({
    code: 'SALES_FLAGGED',
    severity: hasControlFlag(flagged.byFlag) ? 'WARNING' : 'INFO',
    title: plural(flagged.salesCount, 'vente du jour signalée', 'ventes du jour signalées'),
    detail: flaggedSalesDetail(flagged.byFlag),
    count: flagged.salesCount,
    action: { label: 'Voir les ventes signalées', route: null },
  });
}

const SEVERITY_ORDER: Record<HomeSignal['severity'], number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** Signaux triés par gravité (stable : l'ordre d'insertion départage), sans doublon de code. */
export function sortSignals(signals: readonly HomeSignal[]): readonly HomeSignal[] {
  const seen = new Set<string>();
  return signals
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.index - b.index,
    )
    .map(({ item }) => item)
    .filter((item) => (seen.has(item.code) ? false : (seen.add(item.code), true)));
}
