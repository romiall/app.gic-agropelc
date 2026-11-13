/** Icône de chaque nature d'action de l'aide (AV-525). */
import type { IconName } from '../../components/ui/index.js';
import type { HelpKind } from './help-types.js';

export const KIND_ICON: Readonly<Record<HelpKind, IconName>> = {
  create: 'plus',
  read: 'eye',
  update: 'edit',
  cancel: 'x',
  validate: 'check-circle',
  export: 'file',
  go: 'arrow-right',
};
