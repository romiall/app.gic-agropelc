/**
 * Règles partagées de la production (D07 ; ADR-021 : même calcul sur l'appareil et le serveur,
 * sans entrée-sortie). Décisions du porteur du projet du 27/09/2026 intégrées : calibres des œufs
 * à la collecte (AV-046), mortalité validée selon des seuils paramétrés (AV-048), frais généraux
 * répartis au prorata têtes × jours (AV-043, ADR-026), coproduits d'abattage au prorata du poids
 * (AV-032), indicateurs zootechniques (AV-049).
 *
 * Unités : œufs et têtes en entiers ; coûts en XAF entiers (ADR-013) ; poids en grammes ou en
 * kilogrammes selon le nom du paramètre ; taux arrondis à 4 décimales (colonne `hatch_rate`
 * DECIMAL(5,4), dictionnaire production).
 */
import { DomainError, assertSafeInteger } from './errors.js';
import { xaf, type Xaf } from './money.js';
import { quantityMilliUnits, type Quantity } from './quantity.js';

// ---------------------------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------------------------

/** AV-044 (décision du 27/09/2026) : les cinq types sont actifs. */
export const PRODUCTION_LOT_TYPES = [
  'POULET_CHAIR',
  'PONDEUSE',
  'PORC_ENGRAISSEMENT',
  'REPRODUCTEUR_VOLAILLE',
  'PORC_NAISSAGE',
] as const;
export type ProductionLotType = (typeof PRODUCTION_LOT_TYPES)[number];

export type ProductionLotStatus = 'PLANNED' | 'ACTIVE' | 'SELLING' | 'CLOSED' | 'CANCELLED';

export interface LotTypeProfile {
  /** Collectes d'œufs (BR-OEU-001) : pondeuses et reproducteurs (AV-044 : « comme une pondeuse »). */
  readonly laysEggs: boolean;
  /** Naissances (`BIRTH`) et sevrage vers un lot d'engraissement (AV-045). */
  readonly farrows: boolean;
  /** Abattage (transformation multi-produits, AV-032). */
  readonly slaughterable: boolean;
  /** Volaille ou porc (paramètres par espèce, BR-INC-008). */
  readonly species: 'VOLAILLE' | 'PORC';
}

const PROFILES: Record<ProductionLotType, LotTypeProfile> = {
  POULET_CHAIR: { laysEggs: false, farrows: false, slaughterable: true, species: 'VOLAILLE' },
  PONDEUSE: { laysEggs: true, farrows: false, slaughterable: false, species: 'VOLAILLE' },
  PORC_ENGRAISSEMENT: { laysEggs: false, farrows: false, slaughterable: false, species: 'PORC' },
  REPRODUCTEUR_VOLAILLE: {
    laysEggs: true,
    farrows: false,
    slaughterable: false,
    species: 'VOLAILLE',
  },
  PORC_NAISSAGE: { laysEggs: false, farrows: true, slaughterable: false, species: 'PORC' },
};

export function lotTypeProfile(lotType: ProductionLotType): LotTypeProfile {
  const profile = PROFILES[lotType];
  if (!profile) {
    throw new DomainError(`Type de lot inconnu : ${String(lotType)}.`, 'LOT_TYPE_INVALID');
  }
  return profile;
}

/** D07 §8 : toute saisie quotidienne exige un lot `ACTIVE` ou `SELLING` (`LOT_NOT_ACTIVE`). */
export function acceptsDailyEntries(status: ProductionLotStatus): boolean {
  return status === 'ACTIVE' || status === 'SELLING';
}

/** Espèces du catalogue (`catalog.products.species`) admises comme produit d'un type de lot. */
const PRODUCT_SPECIES: Record<ProductionLotType, readonly string[]> = {
  POULET_CHAIR: ['POULET_CHAIR'],
  PONDEUSE: ['PONDEUSE'],
  // Poules et coqs reproducteurs, de souche chair ou ponte (AV-044, AV-099 : un lot par produit).
  REPRODUCTEUR_VOLAILLE: ['POULET_CHAIR', 'PONDEUSE'],
  PORC_ENGRAISSEMENT: ['PORC'],
  // Truies, verrats et porcelets, chacun dans son lot (AV-111).
  PORC_NAISSAGE: ['PORC'],
};

/** BR-PRD-001 : le produit d'un lot est un produit biologique de l'espèce du type de lot. */
export function lotAcceptsProductSpecies(
  lotType: ProductionLotType,
  productSpecies: string | null,
): boolean {
  return productSpecies !== null && (PRODUCT_SPECIES[lotType] ?? []).includes(productSpecies);
}

/** Espèce (volaille, porc) d'un produit biologique du catalogue ; `null` sinon. */
export function speciesGroupOfProduct(productSpecies: string | null): 'VOLAILLE' | 'PORC' | null {
  if (productSpecies === 'POULET_CHAIR' || productSpecies === 'PONDEUSE') return 'VOLAILLE';
  if (productSpecies === 'PORC') return 'PORC';
  return null;
}

/** Première entrée admise sur un lot planifié (`PLANNED` → `ACTIVE`), puis sur un lot actif. */
export function acceptsLotEntries(status: ProductionLotStatus): boolean {
  return status === 'PLANNED' || acceptsDailyEntries(status);
}

export type LotEntrySourceKind = 'PURCHASE' | 'INTERNAL_STOCK' | 'BIRTH' | 'TRANSFER' | 'WEANING';

/**
 * Entrée de lot admise (BR-PRD-004, BR-POR-002 ; AV-045, AV-111) — `LOT_ENTRY_INVALID` sinon :
 * - mise en place (achat ou stock) : tout type de lot ;
 * - naissance : lot de naissage (porcelets) rattaché à un lot de naissage parent (truies) ;
 * - sevrage : d'un lot de naissage vers un lot d'engraissement ;
 * - transfert : entre deux lots distincts de la même espèce.
 */
export function checkLotEntry(input: {
  readonly lotType: ProductionLotType;
  readonly sourceKind: LotEntrySourceKind;
  readonly parentLotType?: ProductionLotType | null;
  readonly sourceLotType?: ProductionLotType | null;
  readonly sameLot?: boolean;
}): void {
  const invalid = (message: string) => new DomainError(message, 'LOT_ENTRY_INVALID');
  const profile = lotTypeProfile(input.lotType);
  switch (input.sourceKind) {
    case 'PURCHASE':
    case 'INTERNAL_STOCK':
      return;
    case 'BIRTH':
      if (
        !profile.farrows ||
        !input.parentLotType ||
        !lotTypeProfile(input.parentLotType).farrows
      ) {
        throw invalid(
          'Une naissance entre dans un lot de naissage (porcelets) rattaché au lot de truies (AV-111).',
        );
      }
      return;
    case 'WEANING':
      if (input.lotType !== 'PORC_ENGRAISSEMENT' || input.sourceLotType !== 'PORC_NAISSAGE') {
        throw invalid(
          'Le sevrage transfère des porcelets d’un lot de naissage vers un lot d’engraissement.',
        );
      }
      return;
    case 'TRANSFER':
      if (
        !input.sourceLotType ||
        input.sameLot === true ||
        lotTypeProfile(input.sourceLotType).species !== profile.species
      ) {
        throw invalid('Un transfert relie deux lots distincts de la même espèce.');
      }
      return;
    default:
      throw invalid(`Origine d’entrée inconnue : ${String(input.sourceKind)}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Entiers et taux
// ---------------------------------------------------------------------------------------------

function assertCount(value: number, label: string, code: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError(`${label} : entier positif ou nul attendu (${value}).`, code);
  }
}

/** Taux arrondi à 4 décimales (demi supérieur) ; `null` si le dénominateur est nul. */
export function rate4(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    throw new DomainError('Taux : valeurs finies attendues.', 'RATE_INVALID');
  }
  if (denominator === 0) return null;
  return Math.floor((numerator / denominator) * 10_000 + 0.5) / 10_000;
}

// ---------------------------------------------------------------------------------------------
// Collecte d'œufs (BR-OEU-001, INV-OEU-01 ; calibres AV-046)
// ---------------------------------------------------------------------------------------------

export interface EggGradeCount {
  /** Calibre (produit « œuf de consommation » d'un calibre, liste paramétrable). */
  readonly grade: string;
  readonly quantity: number;
}

export interface EggCollectionInput {
  readonly collected: number;
  readonly broken: number;
  readonly nonconforming: number;
  readonly hatching: number;
  /** Œufs commercialisables répartis par calibre dès la collecte (AV-046). */
  readonly marketableByGrade: readonly EggGradeCount[];
}

/**
 * Vérifie le bilan d'une collecte : collectés = cassés + non conformes + commercialisables (Σ des
 * calibres) + à couver (INV-OEU-01). Quantités entières ≥ 0, calibres distincts. Renvoie le total
 * commercialisable. `EGG_BALANCE_INVALID` sinon.
 */
export function eggCollectionBalance(input: EggCollectionInput): { readonly marketable: number } {
  for (const [label, value] of [
    ['Œufs collectés', input.collected],
    ['Œufs cassés', input.broken],
    ['Œufs non conformes', input.nonconforming],
    ['Œufs à couver', input.hatching],
  ] as const) {
    assertCount(value, label, 'EGG_BALANCE_INVALID');
  }
  const grades = new Set<string>();
  let marketable = 0;
  for (const line of input.marketableByGrade) {
    assertCount(line.quantity, `Calibre ${line.grade}`, 'EGG_BALANCE_INVALID');
    if (grades.has(line.grade)) {
      throw new DomainError(`Calibre en double : ${line.grade}.`, 'EGG_BALANCE_INVALID');
    }
    grades.add(line.grade);
    marketable += line.quantity;
  }
  const total = input.broken + input.nonconforming + marketable + input.hatching;
  if (total !== input.collected) {
    throw new DomainError(
      `Bilan de collecte faux : ${input.collected} collectés ≠ ${input.broken} cassés + ${input.nonconforming} non conformes + ${marketable} commercialisables + ${input.hatching} à couver.`,
      'EGG_BALANCE_INVALID',
    );
  }
  return { marketable };
}

// ---------------------------------------------------------------------------------------------
// Incubation (BR-INC-003 à 007, INV-INC-01)
// ---------------------------------------------------------------------------------------------

export interface IncubationCounters {
  readonly eggsSet: number;
  readonly infertile: number;
  readonly earlyDead: number;
  readonly accidentalLoss: number;
  readonly unhatched: number;
  readonly hatchedViable: number;
  readonly hatchedNonviable: number;
}

/** Œufs encore présents (incubateur ou éclosoir) avant l'éclosion. */
export function eggsRemaining(counters: IncubationCounters): number {
  return counters.eggsSet - counters.infertile - counters.earlyDead - counters.accidentalLoss;
}

/**
 * Mirage (BR-INC-003) : infertiles et mortalité embryonnaire ≤ œufs encore en incubateur
 * (`INCUBATION_BALANCE_INVALID`).
 */
export function checkCandling(
  counters: IncubationCounters,
  candling: { readonly infertile: number; readonly earlyDead: number },
): void {
  assertCount(candling.infertile, 'Infertiles', 'INCUBATION_BALANCE_INVALID');
  assertCount(candling.earlyDead, 'Mortalité embryonnaire', 'INCUBATION_BALANCE_INVALID');
  if (candling.infertile + candling.earlyDead > eggsRemaining(counters)) {
    throw new DomainError(
      `Mirage : ${candling.infertile + candling.earlyDead} œufs retirés pour ${eggsRemaining(counters)} en incubateur.`,
      'INCUBATION_BALANCE_INVALID',
    );
  }
}

/**
 * Éclosion (BR-INC-005, BR-INC-006) : les œufs restants = non éclos + poussins viables + non
 * viables ; le bilan complet vaut alors INV-INC-01. `INCUBATION_BALANCE_INVALID` sinon.
 */
export function checkHatch(
  counters: IncubationCounters,
  hatch: {
    readonly unhatched: number;
    readonly hatchedViable: number;
    readonly hatchedNonviable: number;
  },
): void {
  assertCount(hatch.unhatched, 'Non éclos', 'INCUBATION_BALANCE_INVALID');
  assertCount(hatch.hatchedViable, 'Poussins viables', 'INCUBATION_BALANCE_INVALID');
  assertCount(hatch.hatchedNonviable, 'Poussins non viables', 'INCUBATION_BALANCE_INVALID');
  const remaining = eggsRemaining(counters);
  const outcome = hatch.unhatched + hatch.hatchedViable + hatch.hatchedNonviable;
  if (outcome !== remaining) {
    throw new DomainError(
      `Éclosion : ${outcome} œufs comptés pour ${remaining} restants (bilan BR-INC-006).`,
      'INCUBATION_BALANCE_INVALID',
    );
  }
}

/** INV-INC-01 : œufs incubés = somme de toutes les issues. */
export function incubationBalanced(counters: IncubationCounters): boolean {
  return (
    counters.eggsSet ===
    counters.infertile +
      counters.earlyDead +
      counters.accidentalLoss +
      counters.unhatched +
      counters.hatchedViable +
      counters.hatchedNonviable
  );
}

/** BR-INC-007 : taux d'éclosion (÷ œufs incubés) et taux sur œufs fertiles (÷ incubés − infertiles). */
export function hatchRates(counters: IncubationCounters): {
  readonly hatchRate: number | null;
  readonly fertileHatchRate: number | null;
} {
  return {
    hatchRate: rate4(counters.hatchedViable, counters.eggsSet),
    fertileHatchRate: rate4(counters.hatchedViable, counters.eggsSet - counters.infertile),
  };
}

// ---------------------------------------------------------------------------------------------
// Mortalité (BR-PRD-005, BR-PRD-006, AV-048)
// ---------------------------------------------------------------------------------------------

export interface MortalityThresholds {
  /** Pourcentage de l'effectif en élevage au-delà duquel la validation est exigée. */
  readonly relativePct: number;
  /** Nombre de têtes au-delà duquel la validation est exigée. */
  readonly absoluteHeads: number;
}

/**
 * BR-PRD-006 : validation exigée si la mortalité dépasse le seuil relatif (sur l'effectif en
 * élevage à `occurred_at`) **ou** le seuil absolu. AV-048 (27/09/2026) : toute mortalité est
 * validée — obtenu avec des seuils à 0 (dépassés dès la première tête), qui restent des
 * paramètres.
 */
export function mortalityRequiresApproval(input: {
  readonly deaths: number;
  readonly headcountInRearing: number;
  readonly thresholds: MortalityThresholds;
}): boolean {
  assertCount(input.deaths, 'Mortalité', 'MORTALITY_INVALID');
  const { relativePct, absoluteHeads } = input.thresholds;
  if (
    !Number.isFinite(relativePct) ||
    relativePct < 0 ||
    !Number.isFinite(absoluteHeads) ||
    absoluteHeads < 0
  ) {
    throw new DomainError('Seuils de mortalité invalides.', 'THRESHOLD_INVALID');
  }
  if (input.deaths > absoluteHeads) return true;
  if (input.headcountInRearing <= 0) return input.deaths > 0;
  return (input.deaths * 100) / input.headcountInRearing > relativePct;
}

// ---------------------------------------------------------------------------------------------
// Coûts (BR-PRD-012, ADR-015, ADR-026)
// ---------------------------------------------------------------------------------------------

/**
 * Coût par tête = coût cumulé du lot ÷ effectif non vendu (BR-PRD-012), arrondi au franc demi
 * supérieur (coût figé d'un mouvement, BR-STK-052). `null` si l'effectif est nul.
 */
export function costPerHeadXaf(totalCostXaf: number, headcount: Quantity): Xaf | null {
  assertSafeInteger(totalCostXaf, 'costPerHeadXaf (coût)');
  const milliHeads = quantityMilliUnits(headcount);
  if (milliHeads <= 0) return null;
  const value = Number(
    (BigInt(totalCostXaf) * 1000n * 2n + BigInt(milliHeads)) / (BigInt(milliHeads) * 2n),
  );
  return xaf(Math.max(0, value));
}

export interface ProRataShare<K extends string = string> {
  readonly key: K;
  readonly amountXaf: Xaf;
}

/**
 * Répartit un montant entier entre des clés au prorata de poids entiers ≥ 0, sans perte ni
 * création de franc (méthode du plus fort reste ; égalité départagée par l'ordre des clés).
 * Poids tous nuls : rien n'est réparti (renvoie des parts nulles).
 */
export function allocateProRata<K extends string>(
  totalXaf: number,
  weights: readonly { readonly key: K; readonly weight: number }[],
): readonly ProRataShare<K>[] {
  assertSafeInteger(totalXaf, 'allocateProRata (montant)');
  if (totalXaf < 0) throw new DomainError('Montant à répartir négatif.', 'AMOUNT_INVALID');
  const seen = new Set<string>();
  for (const w of weights) {
    if (!Number.isInteger(w.weight) || w.weight < 0) {
      throw new DomainError(
        `Poids de répartition invalide pour ${w.key}.`,
        'ALLOCATION_WEIGHT_INVALID',
      );
    }
    if (seen.has(w.key))
      throw new DomainError(`Clé en double : ${w.key}.`, 'ALLOCATION_WEIGHT_INVALID');
    seen.add(w.key);
  }
  const totalWeight = weights.reduce((sum, w) => sum + BigInt(w.weight), 0n);
  if (totalWeight === 0n) return weights.map((w) => ({ key: w.key, amountXaf: xaf(0) }));
  const total = BigInt(totalXaf);
  const base = weights.map((w, index) => {
    const product = total * BigInt(w.weight);
    return { key: w.key, index, amount: product / totalWeight, remainder: product % totalWeight };
  });
  let left = total - base.reduce((sum, b) => sum + b.amount, 0n);
  const byRemainder = [...base].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of byRemainder) {
    if (left === 0n) break;
    share.amount += 1n;
    left -= 1n;
  }
  return base.map((b) => ({ key: b.key, amountXaf: xaf(Number(b.amount)) }));
}

/**
 * Têtes × jours d'une période (AV-043, ADR-026) : somme, sur chaque jour métier de la période,
 * de l'effectif en fin de journée (jamais négatif). `openingHeadcount` est l'effectif au début du
 * premier jour ; `movements` les variations d'effectif datées (jour métier `AAAA-MM-JJ`), dans
 * n'importe quel ordre.
 */
export function headDaysInPeriod(input: {
  readonly openingHeadcount: number;
  readonly movements: readonly { readonly day: string; readonly delta: number }[];
  readonly days: readonly string[];
}): number {
  const deltaByDay = new Map<string, number>();
  for (const m of input.movements) deltaByDay.set(m.day, (deltaByDay.get(m.day) ?? 0) + m.delta);
  let headcount = input.openingHeadcount;
  let total = 0;
  for (const day of input.days) {
    headcount += deltaByDay.get(day) ?? 0;
    total += Math.max(0, headcount);
  }
  return Math.round(total * 1000) / 1000;
}

/**
 * Coproduits d'abattage (AV-032, ADR-026) : coût des animaux abattus réparti entre les produits
 * obtenus au prorata de leur poids (grammes entiers).
 */
export function allocateByWeight<K extends string>(
  totalCostXaf: number,
  outputs: readonly { readonly key: K; readonly weightG: number }[],
): readonly ProRataShare<K>[] {
  return allocateProRata(
    totalCostXaf,
    outputs.map((o) => ({ key: o.key, weight: o.weightG })),
  );
}

/** Coût unitaire d'une sortie (valeur ÷ quantité), arrondi au franc demi supérieur. */
export function unitCostXaf(valueXaf: number, quantity: Quantity): Xaf {
  assertSafeInteger(valueXaf, 'unitCostXaf (valeur)');
  const milli = quantityMilliUnits(quantity);
  if (milli <= 0)
    throw new DomainError('Quantité strictement positive attendue.', 'QUANTITY_INVALID');
  return xaf(Number((BigInt(valueXaf) * 2000n + BigInt(milli)) / (BigInt(milli) * 2n)));
}

// ---------------------------------------------------------------------------------------------
// Pesées et indicateurs (BR-PRD-015, AV-049)
// ---------------------------------------------------------------------------------------------

/** BR-PRD-015 : échantillon > 0, poids moyen > 0 (`WEIGHING_INVALID`). */
export function checkWeighing(input: {
  readonly sampleSize: number;
  readonly avgWeightG: number;
  readonly totalWeightKg?: number | null;
}): void {
  if (!Number.isInteger(input.sampleSize) || input.sampleSize <= 0) {
    throw new DomainError('Pesée : taille d’échantillon entière > 0 attendue.', 'WEIGHING_INVALID');
  }
  if (!Number.isFinite(input.avgWeightG) || input.avgWeightG <= 0) {
    throw new DomainError('Pesée : poids moyen > 0 attendu.', 'WEIGHING_INVALID');
  }
  if (
    input.totalWeightKg !== undefined &&
    input.totalWeightKg !== null &&
    !(input.totalWeightKg > 0)
  ) {
    throw new DomainError('Pesée : poids total > 0 attendu.', 'WEIGHING_INVALID');
  }
}

/** Taux de mortalité cumulée = morts ÷ effectif initial (4 décimales). */
export function mortalityRate(deaths: number, initialHeadcount: number): number | null {
  return rate4(deaths, initialHeadcount);
}

/** Taux de ponte d'un jour = œufs collectés ÷ pondeuses présentes (4 décimales). */
export function layingRate(eggsCollected: number, hensPresent: number): number | null {
  return rate4(eggsCollected, hensPresent);
}

/** Gain moyen quotidien (g/jour) entre deux pesées, arrondi au dixième de gramme. */
export function averageDailyGainG(input: {
  readonly fromAvgWeightG: number;
  readonly toAvgWeightG: number;
  readonly days: number;
}): number | null {
  if (!(input.days > 0)) return null;
  return Math.round(((input.toAvgWeightG - input.fromAvgWeightG) / input.days) * 10) / 10;
}

/**
 * Indice de consommation = aliment consommé (kg) ÷ gain de poids vif du lot (kg), sur la même
 * période ; `null` si le gain est nul ou négatif (indicateur non significatif).
 */
export function feedConversionRatio(feedKg: number, liveWeightGainKg: number): number | null {
  if (!(liveWeightGainKg > 0)) return null;
  return rate4(feedKg, liveWeightGainKg);
}

/** Rendement d'abattage = poids des produits obtenus ÷ poids vif abattu (4 décimales). */
export function slaughterYield(outputWeightG: number, liveWeightG: number): number | null {
  return rate4(outputWeightG, liveWeightG);
}
