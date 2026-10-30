/**
 * Boutons (ADR-049). Hauteur visible de 40 px (48 px en `lg`), zone tactile prolongée par la feuille de
 * style sans agrandir le dessin. Un seul bouton `primary` (plein) par écran : les autres actions passent
 * en `tonal`, `ghost` ou `outline`. `type` vaut « button » par défaut : un bouton ne soumet un formulaire
 * que s'il le demande (`type="submit"`).
 */
import type { ButtonHTMLAttributes } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cx } from './cx.js';
import { Icon, type IconName } from './icons.js';

export type ButtonVariant = 'primary' | 'tonal' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string | false> = {
  primary: false,
  tonal: 'btn-tonal',
  outline: 'btn-outline',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

interface Look {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Pleine largeur. */
  block?: boolean | undefined;
  icon?: IconName | undefined;
  iconEnd?: IconName | undefined;
}

function look({
  variant = 'primary',
  size = 'md',
  block = false,
  className,
}: Look & { className?: string | undefined }): string {
  return cx(
    'btn',
    VARIANT_CLASS[variant],
    size === 'sm' && 'btn-sm',
    size === 'lg' && 'btn-lg',
    block && 'btn-block',
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Look {
  /** Désactive le bouton et affiche une roue : l'action est en cours. */
  loading?: boolean;
}

export function Button({
  variant,
  size,
  block,
  icon,
  iconEnd,
  loading = false,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={look({ variant, size, block, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={18} />
      ) : null}
      {children}
      {iconEnd && !loading ? <Icon name={iconEnd} size={18} /> : null}
    </button>
  );
}

export interface LinkButtonProps extends LinkProps, Look {}

/** Lien de navigation qui a l'apparence d'un bouton. */
export function LinkButton({
  variant,
  size,
  block,
  icon,
  iconEnd,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link className={look({ variant, size, block, className })} {...rest}>
      {icon ? <Icon name={icon} size={18} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={18} /> : null}
    </Link>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'iconEnd' | 'children'> {
  icon: IconName;
  /** Nom accessible, aussi affiché en infobulle. */
  label: string;
}

/** Bouton carré portant une seule icône. */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      className={cx('btn-icon', className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 16 : 20} />
    </Button>
  );
}
