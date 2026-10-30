/**
 * Surfaces et listes (ADR-049) : carte, section, ligne de liste, liste en colonnes, pastille d'état,
 * pastille de personne, tuile d'indicateur. Les listes restent des `ul` et des `li` ; sur ordinateur,
 * la feuille de style les met en colonnes (grille) sans changer les rôles du DOM.
 */
import {
  createElement,
  useId,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { cx } from './cx.js';
import { Icon, type IconName } from './icons.js';
import { initials } from './initials.js';

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

/* --- Carte et section --------------------------------------------------------------------------- */

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'aside';
  /** Marge intérieure de 16 px. */
  padded?: boolean;
}

export function Card({ as = 'div', padded = false, className, ...rest }: CardProps) {
  return createElement(as, { className: cx('card', padded && 'card-pad', className), ...rest });
}

export interface SectionProps {
  title: ReactNode;
  /** Action à droite du titre (lien « Tout voir », bouton). */
  action?: ReactNode;
  headingLevel?: 'h2' | 'h3';
  className?: string;
  children: ReactNode;
}

/** Groupe de contenu sous un titre ; remplace les petits titres gris en capitales. */
export function Section({ title, action, headingLevel = 'h2', className, children }: SectionProps) {
  const id = useId();
  return (
    <section className={cx('section', className)} aria-labelledby={id}>
      <div className="section-head">
        {createElement(headingLevel, { id }, title)}
        {action}
      </div>
      {children}
    </section>
  );
}

/* --- Liste --------------------------------------------------------------------------------------- */

export interface ListProps extends HTMLAttributes<HTMLUListElement> {
  /** Sans cadre de carte (liste posée dans une carte existante). */
  bare?: boolean;
}

export function List({ bare = false, className, ...rest }: ListProps) {
  return <ul className={cx(!bare && 'card', 'list', className)} {...rest} />;
}

export interface ListRowProps {
  /** Icône dans une pastille carrée à gauche. */
  icon?: IconName;
  iconTone?: Tone;
  /** Élément libre à gauche (avatar…), à la place de `icon`. */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Valeur forte à droite (montant). */
  value?: ReactNode;
  /** Pastille d'état sous la valeur. */
  badge?: ReactNode;
  /** Ligne cliquable qui ouvre un écran. */
  to?: string;
  /** Ligne cliquable qui exécute une action. */
  onClick?: () => void;
  className?: string;
}

/** Ligne de liste à trois zones : repère, texte, valeur et état. */
export function ListRow({
  icon,
  iconTone,
  leading,
  title,
  subtitle,
  value,
  badge,
  to,
  onClick,
  className,
}: ListRowProps) {
  const interactive = to !== undefined || onClick !== undefined;
  const content = (
    <>
      {leading ??
        (icon ? (
          <span className={cx('list-lead', iconTone && `is-${iconTone}`)}>
            <Icon name={icon} size={20} />
          </span>
        ) : null)}
      <span className="list-main">
        <span className="list-title">{title}</span>
        {subtitle ? <span className="list-sub">{subtitle}</span> : null}
      </span>
      {value || badge ? (
        <span className="list-end">
          {value ? <span className="list-value">{value}</span> : null}
          {badge}
        </span>
      ) : null}
      {interactive ? <Icon name="chevron-right" size={18} className="list-chev" /> : null}
    </>
  );
  if (to !== undefined) {
    return (
      <li>
        <Link className={cx('list-row', className)} to={to}>
          {content}
        </Link>
      </li>
    );
  }
  if (onClick) {
    return (
      <li>
        <button type="button" className={cx('list-row', className)} onClick={onClick}>
          {content}
        </button>
      </li>
    );
  }
  return (
    <li>
      <div className={cx('list-row', className)}>{content}</div>
    </li>
  );
}

/* --- Liste en colonnes --------------------------------------------------------------------------- */

export interface DataColumn {
  label: ReactNode;
  /** Colonne de nombres : alignée à droite. */
  numeric?: boolean;
}

export interface DataListProps {
  columns: ReadonlyArray<DataColumn>;
  /** Largeurs des colonnes sur ordinateur (`grid-template-columns`). */
  template: string;
  'aria-label'?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Cartes empilées sur téléphone, colonnes alignées avec en-tête dès 900 px. L'en-tête est visuel
 * (`aria-hidden`) : chaque cellule porte son libellé court (`label`) affiché sur téléphone.
 */
export function DataList({
  columns,
  template,
  className,
  children,
  'aria-label': ariaLabel,
}: DataListProps) {
  const style = { '--cols': template } as CSSProperties;
  return (
    <div className={cx('card', 'data-list', className)} style={style}>
      <div className="data-head" aria-hidden="true">
        {columns.map((column, index) => (
          <span key={index} className={column.numeric ? 'is-num' : undefined}>
            {column.label}
          </span>
        ))}
      </div>
      <ul className="data-rows" aria-label={ariaLabel}>
        {children}
      </ul>
    </div>
  );
}

export function DataRow({ className, ...rest }: HTMLAttributes<HTMLLIElement>) {
  return <li className={cx('data-row', className)} {...rest} />;
}

export interface DataCellProps {
  /** Libellé court, affiché devant la valeur sur téléphone. */
  label?: string;
  /** Cellule principale : pleine largeur, en gras (nom du client…). */
  primary?: boolean;
  numeric?: boolean;
  /** Cellule d'actions : alignée à droite. */
  actions?: boolean;
  className?: string;
  children: ReactNode;
}

export function DataCell({ label, primary, numeric, actions, className, children }: DataCellProps) {
  return (
    <div
      className={cx(
        'data-cell',
        primary && 'is-primary',
        numeric && 'is-num',
        actions && 'is-actions',
        className,
      )}
      data-label={label}
    >
      {children}
    </div>
  );
}

/* --- Pastille d'état, personne ------------------------------------------------------------------ */

export type BadgeTone = Tone | 'brand' | 'muted';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Sans le point devant le texte. */
  plain?: boolean;
}

/** Pastille d'état : un point, un texte, un ton sémantique (le texte porte toujours le sens). */
export function Badge({ tone = 'muted', plain = false, className, ...rest }: BadgeProps) {
  return (
    <span className={cx('badge', `badge-${tone}`, plain && 'badge-plain', className)} {...rest} />
  );
}

export interface AvatarProps {
  name: string;
  large?: boolean;
  className?: string;
}

export function Avatar({ name, large = false, className }: AvatarProps) {
  return (
    <span className={cx('avatar', large && 'avatar-lg', className)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/* --- Tuile d'indicateur -------------------------------------------------------------------------- */

export interface SparklineProps {
  values: readonly number[];
}

/** Tracé de tendance : ligne, aire légère, point d'extrémité net (un élément HTML, jamais étiré). */
export function Sparkline({ values }: SparklineProps) {
  if (values.length < 2) return null;
  const width = 100;
  const height = 28;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map(
    (value, index) =>
      [
        (index / (values.length - 1)) * width,
        height - 2 - ((value - min) / span) * (height - 4),
      ] as const,
  );
  const line = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');
  const [lastX, lastY] = points[points.length - 1] ?? [width, height / 2];
  return (
    <div className="spark" aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <path className="spark-area" d={`${line} L${width} ${height} L0 ${height} Z`} />
        <path className="spark-line" d={line} />
      </svg>
      <span
        className="spark-dot"
        style={{ left: `${(lastX / width) * 100}%`, top: `${(lastY / height) * 100}%` }}
      />
    </div>
  );
}

export interface KpiTileProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  delta?: { text: ReactNode; tone: Tone | 'neutral' };
  /** Colore la valeur quand l'indicateur demande de l'attention. */
  tone?: 'neutral' | 'warn' | 'bad';
  icon?: IconName;
  spark?: readonly number[];
}

export function KpiTile({
  label,
  value,
  detail,
  delta,
  tone = 'neutral',
  icon,
  spark,
  className,
  ...rest
}: KpiTileProps) {
  return (
    <div className={cx('tile', tone !== 'neutral' && `tile-${tone}`, className)} {...rest}>
      <p className="tile-head">
        {icon ? (
          <span className="tile-icon">
            <Icon name={icon} size={16} />
          </span>
        ) : null}
        <span>{label}</span>
      </p>
      <p className="tile-value">{value}</p>
      {detail ? <p className="tile-detail">{detail}</p> : null}
      {delta ? (
        <p className={cx('tile-delta', delta.tone !== 'neutral' && `is-${delta.tone}`)}>
          {delta.text}
        </p>
      ) : null}
      {spark ? <Sparkline values={spark} /> : null}
    </div>
  );
}
