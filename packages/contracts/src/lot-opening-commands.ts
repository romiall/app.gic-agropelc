/**
 * Charge utile de la commande de reprise d'un lot en cours, `production.lot_opening.post` (ADR-069, BR-PRD-016 ;
 * AV-541 à AV-544). Contrat partagé entre l'appareil (écran de reprise et chargement par fichier, qui contrôlent avant
 * d'envoyer) et le serveur, qui l'importe pour valider et rejuge tout.
 *
 * L'identifiant du lot qui naîtra est l'`aggregate_id` de l'enveloppe (UUIDv7 de l'appareil) : la commande pose une
 * déclaration en attente de validation ; le lot, son lot de stock, son entrée, son mouvement `OPENING_BALANCE` et sa
 * valeur n'existent qu'à l'approbation. Les bornes numériques et la date sont jugées à la déclaration par la logique
 * pure du domaine (`lotOpeningIssues`), parce qu'elles dépendent de l'instant de la commande.
 */
import { z } from 'zod';
import {
  LOT_OPENING_MAX_HEADCOUNT,
  LOT_OPENING_MAX_UNIT_VALUE_XAF,
  PRODUCTION_LOT_TYPES,
} from '@gic/domain';

const uuid = z.string().uuid();

/** Type de commande, identique à la permission qui la gouverne (comme `inventory.opening.post`). */
export const LOT_OPENING_POST_COMMAND = 'production.lot_opening.post' as const;

/** Type d'agrégat de l'enveloppe : la déclaration de reprise, qui deviendra le lot de même identifiant. */
export const LOT_OPENING_AGGREGATE_TYPE = 'PRODUCTION_LOT_OPENING' as const;

export const lotOpeningPostPayloadSchema = z
  .object({
    lotType: z.enum(PRODUCTION_LOT_TYPES),
    /** Produit biologique du lot (animal, un seul par lot ; BR-PRD-001). */
    productId: uuid,
    /** Bâtiment ou case principal d'une ferme, où se trouve l'effectif repris. */
    mainLocationId: uuid,
    /** Jour métier de mise en place réel (`AAAA-MM-JJ`), pas la date de la reprise. */
    placedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Effectif repris à la date d'arrêt (têtes) : ce qui est réellement présent. */
    quantity: z.number().int().min(1).max(LOT_OPENING_MAX_HEADCOUNT),
    /** Valeur totale déclarée du lot (XAF entiers) : animaux, aliments et soins déjà engagés. */
    valueXaf: z
      .number()
      .int()
      .min(0)
      .max(LOT_OPENING_MAX_HEADCOUNT * LOT_OPENING_MAX_UNIT_VALUE_XAF),
    supplierId: uuid.optional(),
    strain: z.string().trim().min(1).max(100).optional(),
    /** Poids moyen constaté à la reprise (g), pour suivre la croissance ensuite. */
    avgWeightG: z.number().positive().max(1_000_000).optional(),
    notes: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();
export type LotOpeningPostPayload = z.infer<typeof lotOpeningPostPayloadSchema>;
