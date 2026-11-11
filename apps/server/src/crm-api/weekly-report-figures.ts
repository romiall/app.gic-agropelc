/**
 * Chiffres de la semaine d'un commercial pour son bilan hebdomadaire (PP-E ; REQ-307, AV-314, ADR-056). **Jamais
 * saisis, jamais stockés** : composés à la lecture, avec les définitions déjà publiées par chaque module (une seule
 * définition par indicateur, ADR-065 §2) :
 * - **visites sur place**, **nouveaux prospects** (comptes créés) et **nouveaux clients** (conversions) :
 *   `commercialEffort` de `crm` (BR-CRM-019) ;
 * - **CA réalisé** : ventes attribuées au commercial, nettes des annulations (`periodNetRevenue` de `sales`, sans le coût des ventes, BR-VEN-020,
 *   BR-FIN-042) ;
 * - **encaissé** : encaissements qu'il a reçus, nets des annulations (`cashedActivity` de `sales`, AV-244) ;
 * - **casses et pertes** : pertes qu'il a déclarées (`lossesDeclaredBy` d'`inventory`), dont la **valeur est au coût** :
 *   `null` sans le droit de valorisation (RC-05).
 * La semaine va du lundi au dimanche, en jours métier de Douala (BR-ANA-002). Composition transport hors des modules
 * (même précédent que `performance/commercial`) : aucun droit n'est contrôlé ici, l'appelant juge la portée.
 */
import {
  businessDayEndUtc,
  businessDayStartUtc,
  weekDaysOf,
  type WeeklyFigures,
} from '@gic/domain';
import type { Database } from '../platform/kysely/database.provider.js';
import { commercialEffort } from '../modules/crm/application/public/index.js';
import { lossesDeclaredBy } from '../modules/inventory/application/public/index.js';
import { cashedActivity, periodNetRevenue } from '../modules/sales/application/public/index.js';

export async function weeklyFigures(
  db: Database,
  input: {
    readonly userId: string;
    /** Lundi de la semaine, `AAAA-MM-JJ`. */
    readonly weekStart: string;
    /** Vrai si le lecteur détient `inventory.valuation.read` (la valeur des pertes est au coût). */
    readonly includeCosts: boolean;
  },
): Promise<WeeklyFigures> {
  const days = weekDaysOf(input.weekStart);
  const fromDay = days[0]!;
  const toDay = days[days.length - 1]!;
  const fromUtc = businessDayStartUtc(fromDay);
  const toUtc = businessDayEndUtc(toDay);
  const effort = await commercialEffort(db, { userId: input.userId, fromUtc, toUtc });
  const revenue = await periodNetRevenue(db, {
    fromUtc,
    toUtc,
    commercialUserId: input.userId,
  });
  const cashed = await cashedActivity(db, { userIds: [input.userId] }, { fromDay, toDay });
  const losses = await lossesDeclaredBy(db, { userId: input.userId, fromUtc, toUtc });
  return {
    visits: effort.visits,
    newProspects: effort.prospectsCreated,
    newCustomers: effort.newCustomers,
    salesXaf: revenue.netRevenueXaf,
    collectedXaf: cashed.reduce((sum, row) => sum + row.confirmedXaf - row.cancelledXaf, 0),
    lossDeclarations: losses.declarations,
    lossValueXaf: input.includeCosts ? losses.valueXaf : null,
  };
}
