/**
 * Chargement par lots des pièces papier (PP-C ; REQ-303, AV-317, AV-508, AV-078) : l'historique des carnets, en
 * fichier CSV. Une pièce = une ou plusieurs lignes du fichier (une ligne par produit pour une vente, une commande, une
 * réception ou un transfert) réunies par le type et le numéro de la pièce.
 *
 * Aucune règle nouvelle : chaque pièce du fichier est traduite en formulaire de l'écran « Reporter une pièce papier »
 * (`SlipForm`), résolue par la même fonction (`resolveSlip` : mêmes référentiels, mêmes prix à la date de la pièce,
 * mêmes contrôles, même fenêtre d'antidatage), puis transformée en commande par la même correspondance
 * (`buildReportCommand`, prouvée contre le serveur). Un fait accompli saisi hors du système : la commande part « saisie
 * hors ligne », jamais refusée pour un état métier (BR-SYN-007). L'identifiant de la pièce est dérivé de son type et de
 * son numéro : recharger le fichier ne reporte rien deux fois.
 *
 * Non chargée par fichier : la livraison (BL), qui vise une commande précise ligne par ligne ; elle se reporte pièce
 * par pièce à l'écran de report.
 */
import { DomainError, normalizePhone } from '@gic/domain';
import { ROLE_SETS } from '../../app/screens.js';
import { normalizeSlipRef } from '../pieces/registre-carnets.js';
import { buildReportCommand } from '../pieces/report-commands.js';
import {
  emptySlipForm,
  locationChoices,
  resolveSlip,
  slipLocations,
  SLIP_ISSUE_MESSAGES,
  type SlipContext,
  type SlipForm,
} from '../pieces/report-form.js';
import type { DraftLine } from '../sales/sale-form.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import type { CustomerData } from '../sales/types.js';
import { DEVICE_LOSS_CATEGORIES, lossReasons, type LossCategory } from '../stock/loss.js';
import { normalizeHeaderName } from './csv.js';
import { importEntityId } from './ids.js';
import {
  cell,
  entityCode,
  listCode,
  type ColumnDef,
  type FileRecord,
  type ImportEntity,
  type RowOutcome,
} from './model.js';
import { customersByPhone } from './phones.js';

/** Types de pièce chargeables par fichier ; le bon de livraison (BL) se reporte à l'écran, pièce par pièce. */
export const LOADABLE_SLIP_TYPES = ['BV', 'CC', 'RE', 'BD', 'RF', 'BR', 'BT', 'FP'] as const;
export type LoadableSlipType = (typeof LOADABLE_SLIP_TYPES)[number];

/** Pièces qui portent une ligne par produit ; les autres tiennent en une seule ligne du fichier. */
const MULTI_LINE: ReadonlySet<LoadableSlipType> = new Set(['BV', 'CC', 'BR', 'BT']);

const TYPE_LABELS: Readonly<Record<LoadableSlipType, string>> = {
  BV: 'bon de vente',
  CC: 'commande client',
  RE: 'reçu',
  BD: 'bon de décaissement',
  RF: 'remise de fonds',
  BR: 'bon de réception',
  BT: 'bon de transfert',
  FP: 'fiche de perte',
};

const TYPE_SYNONYMS: Readonly<Record<string, LoadableSlipType>> = {
  VENTE: 'BV',
  BON_DE_VENTE: 'BV',
  COMMANDE: 'CC',
  COMMANDE_CLIENT: 'CC',
  RECU: 'RE',
  ENCAISSEMENT: 'RE',
  DEPENSE: 'BD',
  DECAISSEMENT: 'BD',
  BON_DE_DECAISSEMENT: 'BD',
  REMISE: 'RF',
  REMISE_DE_FONDS: 'RF',
  RECEPTION: 'BR',
  BON_DE_RECEPTION: 'BR',
  TRANSFERT: 'BT',
  BON_DE_TRANSFERT: 'BT',
  PERTE: 'FP',
  FICHE_DE_PERTE: 'FP',
};

const LOSS_SYNONYMS: Readonly<Record<string, LossCategory>> = {
  VOL: 'VOL_SUSPECTE',
  INEXPLIQUE: 'INEXPLIQUEE',
  DETERIORE: 'DETERIORATION',
};

const SLIP_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'type',
    label: 'Type de pièce',
    required: true,
    example: 'BV',
    hint: `${LOADABLE_SLIP_TYPES.join(', ')} (ou vente, commande, reçu, dépense, remise, réception, transfert, perte).`,
    aliases: ['type_de_la_piece', 'piece'],
  },
  {
    key: 'numero',
    label: 'Numéro de la pièce',
    required: true,
    example: 'BV-000142',
    hint: 'Le numéro imprimé sur la souche, 20 caractères au plus. Les lignes de même type et de même numéro forment une pièce.',
    aliases: ['numero_de_piece', 'n', 'no'],
  },
  {
    key: 'date',
    label: 'Date de la pièce',
    required: true,
    example: '14/10/2026 09:30',
    hint: 'JJ/MM/AAAA ou AAAA-MM-JJ, suivi de l’heure HH:mm (12:00 à défaut).',
    aliases: ['date_de_la_piece', 'date_et_heure'],
  },
  {
    key: 'motif',
    label: 'Motif d’antidatage',
    required: false,
    example: 'Report du carnet de la semaine',
    hint: 'Obligatoire pour une pièce de plus de 24 h, à défaut du motif commun saisi à l’écran.',
    aliases: ['motif_d_antidatage', 'motif_antidatage'],
  },
  {
    key: 'emplacement',
    label: 'Emplacement',
    required: false,
    example: 'PDV-YDE-POS',
    hint: 'Code ou nom : emplacement de vente (BV), de préparation (CC), de réception (BR), de départ (BT), de la perte (FP).',
  },
  {
    key: 'destination',
    label: 'Destination',
    required: false,
    example: '',
    hint: 'BT : emplacement d’arrivée. RF : compte de destination.',
  },
  {
    key: 'site',
    label: 'Site',
    required: false,
    example: '',
    hint: 'Code ou nom : site de la dépense (BD, obligatoire) ou de l’encaissement (RE).',
  },
  {
    key: 'client',
    label: 'Client',
    required: false,
    example: '677 12 34 56',
    hint: 'Téléphone ou nom exact : facultatif pour une vente (BV) de passage, obligatoire pour CC et RE.',
  },
  {
    key: 'produit',
    label: 'Produit',
    required: false,
    example: 'POULET-CHAIR-1KG',
    hint: 'Code ou nom du produit (BV, CC, BR, BT, FP) ; une ligne par produit.',
  },
  {
    key: 'unite',
    label: 'Unité',
    required: false,
    example: '',
    hint: 'Code de l’unité ; à défaut, l’unité de base du produit.',
  },
  {
    key: 'quantite',
    label: 'Quantité',
    required: false,
    example: '4',
    hint: 'Quantité de la ligne.',
  },
  {
    key: 'prix',
    label: 'Prix unitaire',
    required: false,
    example: '3500',
    hint: 'Prix inscrit sur la pièce (BV, CC) ou prix d’achat (BR), en francs. Vide : le prix catalogue de la date de la pièce.',
  },
  {
    key: 'poids',
    label: 'Poids (kg)',
    required: false,
    example: '',
    hint: 'Pour un produit vendu au poids.',
  },
  {
    key: 'motif_prix',
    label: 'Motif de dérogation de prix',
    required: false,
    example: '',
    hint: 'Code ou libellé du motif quand le prix inscrit diffère du prix catalogue (BV, CC).',
  },
  {
    key: 'moyen',
    label: 'Moyen de paiement',
    required: false,
    example: 'ESPECES',
    hint: 'Code ou libellé (BV, RE) ; espèces à défaut.',
  },
  {
    key: 'montant',
    label: 'Montant',
    required: false,
    example: '14000',
    hint: 'En francs : réglé (BV, vide = payé en totalité), encaissé (RE), dépensé (BD), remis (RF).',
  },
  {
    key: 'reference',
    label: 'Référence du paiement',
    required: false,
    example: '',
    hint: 'Référence de l’opération pour un moyen qui l’exige (mobile money, chèque…).',
  },
  {
    key: 'compte',
    label: 'Compte',
    required: false,
    example: '',
    hint: 'Code ou nom : compte payeur (BD), compte source (RF), compte du règlement (BV, RE) si le moyen l’exige.',
  },
  {
    key: 'categorie',
    label: 'Catégorie',
    required: false,
    example: '',
    hint: 'BD : catégorie de dépense. FP : CASSE, DETERIORATION, IMPROPRE, DESTRUCTION, INEXPLIQUEE ou VOL_SUSPECTE.',
  },
  {
    key: 'motif_perte',
    label: 'Motif de la perte',
    required: false,
    example: '',
    hint: 'Code ou libellé du motif de perte (FP).',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    example: '',
    hint: 'BD : objet de la dépense.',
  },
  {
    key: 'beneficiaire',
    label: 'Bénéficiaire',
    required: false,
    example: '',
    hint: 'BD : à qui l’argent a été remis.',
  },
  {
    key: 'transporteur',
    label: 'Transporteur',
    required: false,
    example: '',
    hint: 'RF : porteur des fonds ; BT : transporteur.',
  },
  {
    key: 'fournisseur',
    label: 'Fournisseur',
    required: false,
    example: '',
    hint: 'BR : code ou nom du fournisseur.',
  },
  {
    key: 'bon_de_livraison',
    label: 'Bon de livraison du fournisseur',
    required: false,
    example: '',
    hint: 'BR : numéro du bon de livraison du fournisseur.',
  },
  {
    key: 'livraison_souhaitee',
    label: 'Livraison souhaitée',
    required: false,
    example: '',
    hint: 'CC : date de livraison souhaitée.',
  },
  {
    key: 'adresse_livraison',
    label: 'Adresse de livraison',
    required: false,
    example: '',
    hint: 'CC.',
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    example: '',
    hint: 'BR, BT : observations ; RF : commentaire ; FP : commentaire (obligatoire pour une perte inexpliquée ou un vol).',
  },
];

/** Colonnes d'en-tête de la pièce : prises de la première ligne qui les renseigne, jamais en désaccord ensuite. */
const HEADER_KEYS = SLIP_COLUMNS.map((column) => column.key).filter(
  (key) => !['produit', 'unite', 'quantite', 'prix', 'poids'].includes(key),
);

// --- Lecture des cellules -------------------------------------------------------------------------------------------

const two = (value: number): string => String(value).padStart(2, '0');

function validDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * `JJ/MM/AAAA` ou `AAAA-MM-JJ` (séparateurs `/`, `-` ou `.`), puis `HH:mm` s'il est donné : `{ day, time }` au format
 * du champ de date de l'écran (`AAAA-MM-JJ`, `HH:mm`), ou `null`. L'heure vaut midi à défaut.
 */
export function parseSlipDate(
  text: string,
): { readonly day: string; readonly time: string } | null {
  const match =
    /^(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}))(?:[\sT]+(\d{1,2})[:h](\d{2}))?$/.exec(
      text.trim(),
    );
  if (!match) return null;
  const isoFirst = match[1] !== undefined;
  const year = Number(isoFirst ? match[1] : match[6]);
  const month = Number(isoFirst ? match[2] : match[5]);
  const day = Number(isoFirst ? match[3] : match[4]);
  const hour = match[7] === undefined ? 12 : Number(match[7]);
  const minute = match[8] === undefined ? 0 : Number(match[8]);
  if (!validDay(year, month, day) || hour > 23 || minute > 59) return null;
  return { day: `${year}-${two(month)}-${two(day)}`, time: `${two(hour)}:${two(minute)}` };
}

type Found<T> = { readonly item: T } | { readonly problem: string };

/** Élément dont le code (d'abord) ou le nom correspond au texte, ou la raison pour laquelle il n'y en a pas un seul. */
function find<T>(
  items: readonly T[],
  text: string,
  what: string,
  codes: (item: T) => readonly string[],
  names: (item: T) => readonly string[],
): Found<T> {
  const wanted = normalizeHeaderName(text);
  const same = (values: readonly string[]) =>
    values.some((value) => normalizeHeaderName(value) === wanted);
  const byCode = items.filter((item) => same(codes(item)));
  const matches = byCode.length > 0 ? byCode : items.filter((item) => same(names(item)));
  if (matches.length === 1) return { item: matches[0]! };
  return {
    problem:
      matches.length > 1
        ? `${what} « ${text} » ambigu : écrire son code.`
        : `${what} « ${text} » inconnu.`,
  };
}

function findCustomer(
  customers: readonly CustomerData[],
  text: string,
  countryCode: string,
): Found<CustomerData> {
  let phone: string | null = null;
  try {
    phone = normalizePhone(text, countryCode);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  if (phone !== null) {
    const holder = customersByPhone(customers, countryCode).get(phone);
    if (holder) return { item: holder };
  }
  return find(
    customers.filter((customer) => customer.merged_into_id === null),
    text,
    'Client',
    () => [],
    (customer) => [customer.display_name],
  );
}

// --- Traduction d'une pièce du fichier en formulaire de l'écran ----------------------------------------------------

interface Built {
  readonly form: SlipForm | null;
  readonly issues: readonly string[];
}

/** Valeurs d'en-tête de la pièce, avec les lignes qui se contredisent. */
function headerOf(group: readonly FileRecord[]): {
  readonly header: Record<string, string>;
  readonly issues: string[];
} {
  const header: Record<string, string> = {};
  const issues: string[] = [];
  for (const { line, record } of group) {
    for (const key of HEADER_KEYS) {
      const value = cell(record, key);
      if (value === undefined) continue;
      const known = header[key];
      if (known === undefined) header[key] = value;
      else if (normalizeHeaderName(known) !== normalizeHeaderName(value)) {
        const label = SLIP_COLUMNS.find((column) => column.key === key)?.label ?? key;
        issues.push(
          `Ligne ${line} : « ${label} » diffère de celui de la première ligne de la pièce.`,
        );
      }
    }
  }
  return { header, issues };
}

function buildForm(
  type: LoadableSlipType,
  group: readonly FileRecord[],
  context: SlipContext,
  options: { readonly countryCode: string; readonly backdatedReason: string },
): Built {
  const { refs, userId } = context;
  const { countryCode, backdatedReason } = options;
  const { header, issues } = headerOf(group);
  const problems: string[] = [...issues];
  const note = (found: Found<unknown>): void => {
    if ('problem' in found) problems.push(found.problem);
  };

  let form: SlipForm = {
    ...emptySlipForm(context.now, type),
    paperRef: header['numero'] ?? '',
    backdatedReason: header['motif'] ?? backdatedReason,
    notes: header['notes'] ?? '',
    description: header['description'] ?? '',
    payeeName: header['beneficiaire'] ?? '',
    carrierName: header['transporteur'] ?? '',
    deliveryNoteRef: header['bon_de_livraison'] ?? '',
    deliveryAddress: header['adresse_livraison'] ?? '',
  };

  const date = header['date'] === undefined ? null : parseSlipDate(header['date']);
  if (header['date'] === undefined || date === null) {
    problems.push(
      header['date'] === undefined
        ? 'Date de la pièce obligatoire.'
        : `Date « ${header['date']} » invalide : JJ/MM/AAAA ou AAAA-MM-JJ, puis HH:mm.`,
    );
  } else {
    form = { ...form, occurredAt: `${date.day}T${date.time}` };
  }

  const locations =
    type === 'BV' || type === 'CC'
      ? locationChoices(type, refs, userId)
      : slipLocations(refs, userId);
  const place = (text: string, what: string) => {
    const found = find(
      locations,
      text,
      what,
      (l) => [l.code],
      (l) => [l.name],
    );
    note(found);
    return 'item' in found ? found.item.id : '';
  };
  if (header['emplacement'] !== undefined) {
    form = { ...form, locationId: place(header['emplacement'], 'Emplacement') };
  }
  if (type === 'BT' && header['destination'] !== undefined) {
    form = { ...form, toLocationId: place(header['destination'], 'Destination') };
  }

  if (header['site'] !== undefined) {
    const found = find(
      [...refs.sites.values()].filter((site) => site.status === 'ACTIVE'),
      header['site'],
      'Site',
      (site) => [site.code],
      (site) => [site.name],
    );
    note(found);
    if ('item' in found) form = { ...form, siteId: found.item.id };
  }

  if (header['client'] !== undefined) {
    const found = findCustomer(refs.customers, header['client'], countryCode);
    note(found);
    if ('item' in found) form = { ...form, customerId: found.item.id };
  }

  if (header['fournisseur'] !== undefined) {
    const found = find(
      [...refs.suppliers.values()],
      header['fournisseur'],
      'Fournisseur',
      (supplier) => [supplier.code],
      (supplier) => [supplier.name],
    );
    note(found);
    if ('item' in found) form = { ...form, supplierId: found.item.id };
  }

  if (header['livraison_souhaitee'] !== undefined) {
    const day = parseSlipDate(header['livraison_souhaitee']);
    if (day === null)
      problems.push(`Livraison souhaitée « ${header['livraison_souhaitee']} » invalide.`);
    else form = { ...form, requestedDeliveryDate: day.day };
  }

  // Règlement (BV, RE) et montants (BD, RF).
  const accountByText = (text: string) =>
    find(
      refs.cashAccounts.filter((account) => account.status === 'ACTIVE'),
      text,
      'Compte',
      (account) => [account.code],
      (account) => [account.name],
    );
  let paymentAccountId: string | null = null;
  let method: string | null = null;
  if (header['moyen'] !== undefined) {
    const found = find(
      refs.paymentMethods,
      header['moyen'],
      'Moyen de paiement',
      (m) => [m.code],
      (m) => [m.label],
    );
    note(found);
    if ('item' in found) method = found.item.code;
  }
  if (type === 'BV' || type === 'RE') {
    if (header['compte'] !== undefined) {
      const found = accountByText(header['compte']);
      note(found);
      if ('item' in found) paymentAccountId = found.item.id;
    }
    form = {
      ...form,
      payment: {
        methodCode: method,
        amountText: header['montant'] ?? null,
        reference: header['reference'] ?? '',
        accountId: paymentAccountId,
      },
    };
  } else {
    form = { ...form, amountText: header['montant'] ?? '' };
  }
  if (type === 'BD' || type === 'RF') {
    if (header['compte'] !== undefined) {
      const found = accountByText(header['compte']);
      note(found);
      if ('item' in found) form = { ...form, accountId: found.item.id };
    }
  }
  if (type === 'RF' && header['destination'] !== undefined) {
    const found = find(
      refs.cashTransferTargets,
      header['destination'],
      'Compte de destination',
      (target) => [target.code],
      (target) => [target.name],
    );
    note(found);
    if ('item' in found) form = { ...form, toAccountId: found.item.id };
  }

  if (type === 'BD' && header['categorie'] !== undefined) {
    const found = find(
      refs.expenseCategories.filter((category) => category.is_active && !category.is_system),
      header['categorie'],
      'Catégorie de dépense',
      (category) => [category.code],
      (category) => [category.label],
    );
    note(found);
    if ('item' in found) form = { ...form, categoryId: found.item.id };
  }

  if (type === 'FP') {
    if (header['categorie'] !== undefined) {
      const code = listCode(header['categorie']);
      const category = (DEVICE_LOSS_CATEGORIES as readonly string[]).includes(code)
        ? (code as LossCategory)
        : LOSS_SYNONYMS[code];
      if (category === undefined) {
        problems.push(
          `Catégorie de perte « ${header['categorie']} » inconnue (${DEVICE_LOSS_CATEGORIES.join(', ')}).`,
        );
      } else {
        form = { ...form, lossCategory: category };
        if (header['motif_perte'] !== undefined) {
          const found = find(
            lossReasons(refs.reasonCodes, category),
            header['motif_perte'],
            'Motif de perte',
            (reason) => [reason.code],
            (reason) => [reason.label],
          );
          note(found);
          if ('item' in found) form = { ...form, lossReasonId: found.item.id };
        }
      }
    }
  }

  if ((type === 'BV' || type === 'CC') && header['motif_prix'] !== undefined) {
    const found = find(
      refs.reasonCodes.filter((reason) => reason.category === 'PRICE_OVERRIDE' && reason.is_active),
      header['motif_prix'],
      'Motif de dérogation de prix',
      (reason) => [reason.code],
      (reason) => [reason.label],
    );
    note(found);
    if ('item' in found) form = { ...form, overrideReasonId: found.item.id };
  }

  // Lignes de produit.
  const wantsLines = MULTI_LINE.has(type) || type === 'FP';
  if (!MULTI_LINE.has(type) && group.length > 1) {
    problems.push(
      `Une pièce ${type} (${TYPE_LABELS[type]}) tient en une seule ligne : ${group.length} lignes portent ce numéro.`,
    );
  }
  if (wantsLines) {
    const lines: DraftLine[] = [];
    for (const { line, record } of group) {
      const productText = cell(record, 'produit');
      if (productText === undefined) {
        problems.push(`Ligne ${line} : produit obligatoire.`);
        continue;
      }
      const found = find(
        refs.products,
        productText,
        'Produit',
        (product) => [product.code],
        (product) => [product.name],
      );
      if ('problem' in found) {
        problems.push(`Ligne ${line} : ${found.problem}`);
        continue;
      }
      const product = found.item;
      const unitCode = entityCode(cell(record, 'unite') ?? product.base_unit_code);
      if (!saleUnitsOf(product, refs).some((unit) => unit.unitCode === unitCode)) {
        problems.push(
          `Ligne ${line} : unité « ${unitCode} » inconnue pour le produit « ${product.code} ».`,
        );
        continue;
      }
      lines.push({
        key: String(line),
        productId: product.id,
        unitCode,
        quantityText: cell(record, 'quantite') ?? '',
        weightText: cell(record, 'poids') ?? '',
        priceText: cell(record, 'prix') ?? null,
        overrideReasonId: null,
      });
      if (type === 'FP') break;
    }
    form = { ...form, lines };
  }

  return { form: problems.length > 0 ? null : form, issues: problems };
}

// --- Entité --------------------------------------------------------------------------------------------------------

const typeOf = (text: string | undefined): LoadableSlipType | 'BL' | null => {
  if (text === undefined) return null;
  const code = listCode(text);
  if (code === 'BL') return 'BL';
  const direct = (LOADABLE_SLIP_TYPES as readonly string[]).includes(code)
    ? (code as LoadableSlipType)
    : undefined;
  return direct ?? TYPE_SYNONYMS[code] ?? null;
};

async function planSlip(
  group: readonly FileRecord[],
  refs: Parameters<ImportEntity['planRow']>[1],
): Promise<RowOutcome> {
  const first = group[0]!.record;
  const typeText = cell(first, 'type');
  const type = typeOf(typeText);
  const paperRef = normalizeSlipRef(cell(first, 'numero') ?? '');
  const key = `${type ?? typeText ?? '?'} ${paperRef}`.trim();
  const fail = (...issues: string[]): RowOutcome => ({ key, issues, commands: [] });

  if (typeText === undefined) return fail('Type de pièce obligatoire.');
  if (type === null) {
    return fail(`Type de pièce « ${typeText} » inconnu (${LOADABLE_SLIP_TYPES.join(', ')}).`);
  }
  if (type === 'BL') {
    return fail(
      'Le bon de livraison (BL) se reporte pièce par pièce, à l’écran « Reporter une pièce papier ».',
    );
  }
  if (paperRef === '') return fail('Numéro de la pièce obligatoire.');
  const context = refs.slipContext;
  if (context === undefined) return fail('Référentiels de l’appareil indisponibles.');

  const built = buildForm(type, group, context, {
    countryCode: refs.phoneCountryCode,
    backdatedReason: refs.defaultBackdatedReason ?? '',
  });
  if (built.form === null) return fail(...built.issues);
  const resolution = resolveSlip(built.form, context);
  if (!resolution.ok) {
    return fail(...resolution.issues.map((issue) => SLIP_ISSUE_MESSAGES[issue]));
  }
  const { slip, meta } = resolution;
  const command = buildReportCommand(slip, {
    paperRef: meta.paperRef,
    occurredAt: meta.occurredAt,
    backdatedReason: meta.backdatedReason,
    aggregateId: await importEntityId('slip', `${type}|${meta.paperRef}`),
    dependsOn: meta.dependsOn,
  });
  return {
    key: `${type} ${meta.paperRef}`,
    issues: [],
    exists: refs.reportedSlips.has(`${type}|${meta.paperRef}`),
    commands: [
      {
        commandType: command.commandType,
        aggregateType: command.aggregateType,
        aggregateId: command.aggregateId,
        payload: command.payload,
        occurredAt: command.occurredAt,
        backdatedReason: command.backdatedReason,
        capturedOffline: command.capturedOffline,
        ...(command.dependsOn.length > 0 ? { dependsOn: command.dependsOn } : {}),
        localFlags: command.localFlags,
      },
    ],
  };
}

export const SLIPS_ENTITY: ImportEntity = {
  id: 'slips',
  label: 'Pièces papier (historique des carnets)',
  description:
    'Pièces des carnets à souche reportées en lot : une pièce par numéro, une ligne par produit pour les ventes, commandes, réceptions et transferts. Mêmes contrôles que l’écran « Reporter une pièce papier ».',
  columns: SLIP_COLUMNS,
  order: 50,
  roles: ROLE_SETS.paperSlipReport,
  planRow: (record, refs) => planSlip([{ line: 0, record }], refs),
  groupKey(record) {
    const type = cell(record, 'type');
    const ref = cell(record, 'numero');
    if (type === undefined || ref === undefined) return undefined;
    return `${typeOf(type) ?? listCode(type)}|${normalizeSlipRef(ref)}`;
  },
  planGroup: (group, refs) => planSlip(group, refs),
};
