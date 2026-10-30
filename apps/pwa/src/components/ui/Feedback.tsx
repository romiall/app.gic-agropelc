/**
 * Retours à l'utilisateur (ADR-049) : bandeau, état vide, squelette, roue, feuille du bas et
 * notifications. Le ton d'un bandeau décide de son rôle ARIA : `alert` pour une erreur ou une
 * alerte (lu tout de suite), `status` sinon.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './Button.js';
import { cx } from './cx.js';
import { Icon, type IconName } from './icons.js';
import type { Tone } from './Surface.js';
import { ToastContext, type ToastApi } from './toast-context.js';

/* --- Bandeau ------------------------------------------------------------------------------------- */

export type BannerTone = 'info' | 'ok' | 'warn' | 'bad' | 'muted';

const BANNER_ICON: Record<BannerTone, IconName> = {
  info: 'info',
  ok: 'check-circle',
  warn: 'alert',
  bad: 'alert',
  muted: 'info',
};

export interface BannerProps {
  tone?: BannerTone;
  /** Rôle ARIA : par défaut `alert` pour une erreur ou une alerte, `status` sinon. */
  role?: 'alert' | 'status';
  title?: ReactNode;
  /** Action sous le texte (bouton ou lien). */
  action?: ReactNode;
  /** Affiche une croix qui referme le bandeau. */
  onDismiss?: () => void;
  className?: string;
  children?: ReactNode;
}

export function Banner({
  tone = 'info',
  role,
  title,
  action,
  onDismiss,
  className,
  children,
}: BannerProps) {
  const { t } = useTranslation();
  return (
    <div className={cx('banner', `banner-${tone}`, className)}>
      <Icon name={BANNER_ICON[tone]} size={20} className="banner-icon" />
      {/* Le rôle est sur le corps (texte, titre, action), pas sur l'icône ni sur la croix. */}
      <div
        className="banner-body"
        role={role ?? (tone === 'bad' || tone === 'warn' ? 'alert' : 'status')}
      >
        {title ? <p className="banner-title">{title}</p> : null}
        {children}
        {action ? <div className="banner-action">{action}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton icon="x" label={t('ui.close')} size="sm" onClick={onDismiss} />
      ) : null}
    </div>
  );
}

/* --- États vide et chargement -------------------------------------------------------------------- */

export interface EmptyStateProps {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  /** Prochaine action possible (bouton ou lien). */
  action?: ReactNode;
}

export function EmptyState({ icon = 'box', title, children, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={24} />
      </span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  radius?: CSSProperties['borderRadius'];
  className?: string;
}

export function Skeleton({ width = '100%', height = 16, radius, className }: SkeletonProps) {
  return (
    <span
      className={cx('skeleton', className)}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/** Lignes de chargement d'une liste : un seul message « Chargement… » pour les lecteurs d'écran. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="skeleton-rows" role="status" aria-label={t('ui.loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={56} radius="var(--radius-lg)" />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  return <span className="spinner" role="status" aria-label={label ?? t('ui.loading')} />;
}

/* --- Feuille du bas / boîte centrée : `<dialog>` natif (focus, Échap et fond inerte gratuits) --- */

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Boutons du pied de la feuille. */
  footer?: ReactNode;
  children: ReactNode;
}

export function Sheet({ open, onClose, title, footer, children }: SheetProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    } else if (!open && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby={titleId}
      // Échap ou `close()` : la fermeture venue du navigateur est répercutée sur l'état de l'appelant.
      onClose={() => {
        if (open) onClose();
      }}
      // Un clic sur la zone hors de la feuille tombe sur le `<dialog>` lui-même.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-panel">
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="x" label={t('ui.close')} onClick={onClose} />
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}

/* --- Notifications ------------------------------------------------------------------------------- */

interface ToastItem {
  id: number;
  message: ReactNode;
  tone: Tone;
}

const TOAST_ICON: Record<Tone, IconName> = {
  info: 'info',
  ok: 'check-circle',
  warn: 'alert',
  bad: 'alert',
};

/** Notifications brèves (4 s ; 7 s pour une erreur). À monter une fois, près de la racine. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const notify = useCallback((message: ReactNode, tone: Tone = 'info') => {
    const id = nextId.current++;
    setItems((current) => [...current, { id, message, tone }]);
    const timer = window.setTimeout(
      () => {
        timers.current.delete(timer);
        setItems((current) => current.filter((item) => item.id !== id));
      },
      tone === 'bad' ? 7000 : 4000,
    );
    timers.current.add(timer);
  }, []);

  const api = useMemo<ToastApi>(() => ({ notify }), [notify]);

  return (
    <ToastContext value={api}>
      {children}
      <div className="toasts" role="region" aria-label={t('ui.notifications')}>
        {items.map((item) => (
          <div key={item.id} className="toast" role={item.tone === 'bad' ? 'alert' : 'status'}>
            <Icon name={TOAST_ICON[item.tone]} size={18} />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
