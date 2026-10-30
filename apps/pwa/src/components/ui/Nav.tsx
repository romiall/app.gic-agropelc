/**
 * Navigation dans l'écran (ADR-049) : onglets accessibles (clavier : flèches, début, fin) et en-tête de
 * page (retour, titre, sous-titre, actions). La barre d'onglets du bas et la barre latérale de la
 * coquille arrivent au lot L2.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from './Surface.js';
import { Icon } from './icons.js';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Compteur affiché dans une pastille. */
  count?: number;
}

export interface TabsProps<T extends string> {
  /** Nom accessible de la liste d'onglets. */
  label: string;
  value: T;
  items: ReadonlyArray<TabItem<T>>;
  onChange: (value: T) => void;
  /** Préfixe des identifiants, à repasser à `TabPanel`. */
  idPrefix: string;
}

export function Tabs<T extends string>({ label, value, items, onChange, idPrefix }: TabsProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = items.length - 1;
    let next: number;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    event.preventDefault();
    const item = items[next];
    if (!item) return;
    onChange(item.id);
    buttons.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className="tabs">
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${item.id}`}
          aria-selected={item.id === value}
          aria-controls={`${idPrefix}-panel-${item.id}`}
          tabIndex={item.id === value ? 0 : -1}
          className="tabs-item"
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item.label}
          {item.count !== undefined ? (
            <Badge tone="brand" plain>
              {item.count}
            </Badge>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix: string;
  id: string;
  active: boolean;
  children: ReactNode;
}

export function TabPanel({ idPrefix, id, active, children }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      hidden={!active}
    >
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Route du retour : affiche un lien « Retour » au-dessus du titre. */
  backTo?: string;
  backLabel?: string;
  /** Actions de la page, à droite du titre (une seule action pleine). */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, backTo, backLabel, actions }: PageHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="page-header">
      {backTo ? (
        <Link className="page-back" to={backTo}>
          <Icon name="chevron-left" size={18} />
          {backLabel ?? t('ui.back')}
        </Link>
      ) : null}
      <div className="page-title">
        <h1>{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
