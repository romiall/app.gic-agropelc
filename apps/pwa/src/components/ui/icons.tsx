/**
 * Icône de l'interface (ADR-049) : trait de 1,8 px sur une grille de 24 px, couleur du texte courant.
 * Une icône décorative est masquée aux lecteurs d'écran ; passer `title` pour en faire une image nommée.
 */
import type { SVGProps } from 'react';
import { cx } from './cx.js';
import { ICONS, type IconName } from './icon-set.js';

export type { IconName } from './icon-set.js';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  size?: number;
  /** Nom accessible : sans lui, l'icône est décorative (`aria-hidden`). */
  title?: string;
}

export function Icon({ name, size = 20, title, className, ...rest }: IconProps) {
  return (
    <svg
      className={cx('icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {ICONS[name]}
    </svg>
  );
}
