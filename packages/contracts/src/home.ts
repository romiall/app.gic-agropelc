/**
 * Accueil par rôle (ECR-ADM-03, UX-01 ; ADR-030) : réponse de `GET /api/v1/home`, partagée entre
 * le serveur (qui la calcule) et la PWA (qui l'affiche). Tout indicateur est **calculé** à partir
 * des opérations (BR-ANA-001) ; les montants sont en XAF entiers (ADR-013).
 *
 * Structure : des **signaux** (urgences et points d'attention, toutes fonctions confondues,
 * triés par gravité), puis une **section par rôle** de l'utilisateur (actions du jour, indicateurs,
 * activité récente) : un utilisateur multi-rôles voit l'union des sections (UX-01).
 */
import { z } from 'zod';

export const HOME_TONES = ['neutral', 'good', 'warn', 'bad'] as const;
export const homeToneSchema = z.enum(HOME_TONES);
export type HomeTone = z.infer<typeof homeToneSchema>;

export const HOME_UNITS = ['XAF', 'COUNT', 'PERCENT', 'HEADS', 'KG'] as const;
export const homeUnitSchema = z.enum(HOME_UNITS);
export type HomeUnit = z.infer<typeof homeUnitSchema>;

export const homeKpiSchema = z.object({
  /** Code du dictionnaire des indicateurs (D11 §7.1) quand il existe, sinon code local. */
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  /** `null` : valeur non disponible (mesure financière sans droit de lecture, aucune donnée). */
  value: z.number().nullable(),
  unit: homeUnitSchema,
  /** Complément court sous la valeur (« 12 ventes », « sur 5 sites »). */
  detail: z.string().max(120).nullable(),
  /** Évolution par rapport à la période précédente ; absente quand elle n'a pas de sens. */
  delta: z
    .object({
      label: z.string().max(80),
      direction: z.enum(['up', 'down', 'flat']),
      tone: homeToneSchema,
    })
    .nullable(),
  /** Courbe de quelques points (un par jour métier) pour un graphique miniature. */
  series: z
    .array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), value: z.number() }))
    .nullable(),
  tone: homeToneSchema,
});
export type HomeKpi = z.infer<typeof homeKpiSchema>;

export const HOME_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;
export const homeSeveritySchema = z.enum(HOME_SEVERITIES);
export type HomeSeverity = z.infer<typeof homeSeveritySchema>;

export const homeActionSchema = z.object({
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  hint: z.string().max(120).nullable(),
  /** Chemin de l'écran dans la PWA ; `null` tant que l'écran n'existe pas (« bientôt »). */
  route: z.string().max(120).nullable(),
  primary: z.boolean(),
});
export type HomeAction = z.infer<typeof homeActionSchema>;

export const homeSignalSchema = z.object({
  code: z.string().min(1).max(40),
  severity: homeSeveritySchema,
  title: z.string().min(1).max(120),
  detail: z.string().max(240).nullable(),
  /** Nombre d'éléments concernés (validations en attente, créances en retard…). */
  count: z.number().int().nonnegative().nullable(),
  action: z.object({ label: z.string().max(60), route: z.string().max(120).nullable() }).nullable(),
});
export type HomeSignal = z.infer<typeof homeSignalSchema>;

export const homeActivitySchema = z.object({
  code: z.string().min(1).max(40),
  title: z.string().min(1).max(80),
  items: z.array(
    z.object({
      id: z.string(),
      /** Instant métier (`occurred_at`, ISO 8601). */
      at: z.string(),
      label: z.string().max(120),
      detail: z.string().max(120).nullable(),
      /** Montant en XAF quand il s'applique. */
      amountXaf: z.number().int().nullable(),
      tone: homeToneSchema,
    }),
  ),
});
export type HomeActivity = z.infer<typeof homeActivitySchema>;

export const homeSectionSchema = z.object({
  role: z.string().min(1).max(40),
  roleLabel: z.string().min(1).max(60),
  /** Périmètre lu, en clair (« Toute l'entreprise », « Votre équipe », « Vos sites »). */
  scopeLabel: z.string().max(80),
  actions: z.array(homeActionSchema),
  kpis: z.array(homeKpiSchema),
  activity: z.array(homeActivitySchema),
});
export type HomeSection = z.infer<typeof homeSectionSchema>;

export const homeResponseSchema = z.object({
  /** Instant du calcul (ISO 8601) : fraîcheur affichée (BR-ANA-005). */
  generatedAt: z.string(),
  /** Jour métier du calcul (`Africa/Douala`). */
  businessDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  user: z.object({ fullName: z.string(), roles: z.array(z.string()) }),
  signals: z.array(homeSignalSchema),
  sections: z.array(homeSectionSchema),
});
export type HomeResponse = z.infer<typeof homeResponseSchema>;
