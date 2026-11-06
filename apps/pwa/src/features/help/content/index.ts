/** Contenu de l'aide, assemblé (AV-525, ADR-058). */
import type { ScreenHelp } from '../help-types.js';
import { ADMIN_HELP } from './admin.js';
import { CRM_HELP } from './crm.js';
import { FINANCE_HELP } from './finance.js';
import { GENERAL_HELP } from './general.js';
import { PILOTAGE_HELP } from './pilotage.js';
import { PROCUREMENT_HELP } from './procurement.js';
import { PRODUCTION_HELP } from './production.js';
import { SALES_HELP } from './sales.js';
import { STOCK_HELP } from './stock.js';

export { FAQ, JOURNEYS } from './journeys.js';

/** Une entrée par route de l'application (un essai le vérifie). */
export const SCREEN_HELP: readonly ScreenHelp[] = [
  ...GENERAL_HELP,
  ...PRODUCTION_HELP,
  ...STOCK_HELP,
  ...PROCUREMENT_HELP,
  ...SALES_HELP,
  ...CRM_HELP,
  ...FINANCE_HELP,
  ...ADMIN_HELP,
  ...PILOTAGE_HELP,
];
