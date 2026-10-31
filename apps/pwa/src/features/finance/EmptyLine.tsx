/**
 * État vide compact des sections empilées de la finance (ADR-049, lot L8) : une ligne, l'icône et le texte,
 * à la place du bloc centré de `EmptyState` (trois files de travail vides se suivent sur la trésorerie).
 */
import { EmptyState, type IconName } from '../../components/ui/index.js';
import './finance.css';

export function EmptyLine({
  icon = 'check-circle',
  title,
}: {
  readonly icon?: IconName;
  readonly title: string;
}) {
  return (
    <div className="fin-compact">
      <EmptyState icon={icon} title={title} />
    </div>
  );
}
