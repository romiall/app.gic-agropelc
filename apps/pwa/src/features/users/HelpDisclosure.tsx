/**
 * Explication repliée des écrans d'administration (ADR-049, lot L9) : un titre qui se touche, le texte
 * d'aide dessous une fois ouvert. L'aide qui précédait chaque liste ne prend plus de place tant qu'on
 * ne la demande pas ; le texte lui-même ne change pas.
 */
import type { ReactNode } from 'react';
import { Icon } from '../../components/ui/index.js';
import './admin.css';

export function HelpDisclosure({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="adm-help">
      <summary>
        <Icon name="info" size={18} />
        <span>{title}</span>
        <Icon name="chevron-down" size={18} />
      </summary>
      <div className="adm-help-body">{children}</div>
    </details>
  );
}
