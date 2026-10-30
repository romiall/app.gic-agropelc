/**
 * Champs de formulaire (ADR-049) : `Field` relie le libellé, l'aide et l'erreur au contrôle (`htmlFor`,
 * `aria-describedby`, `aria-invalid`), si bien que les essais par libellé restent valables. Les contrôles
 * nus (`Input`, `Select`, `Textarea`) ne portent que la classe ; la forme vient de `styles/base.css`.
 */
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from './cx.js';

/** Propriétés à poser sur le contrôle que `Field` enveloppe. */
export interface ControlProps {
  id: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: true | undefined;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Ajoute « (facultatif) » au libellé. */
  optional?: boolean;
  /** Unité affichée à droite du contrôle (F CFA, kg, plateaux…). */
  unit?: ReactNode;
  className?: string;
  children: (control: ControlProps) => ReactNode;
}

export function Field({ label, hint, error, optional, unit, className, children }: FieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={cx('field', className)}>
      <label htmlFor={id} className="field-label">
        {label}
        {optional ? <span className="field-optional"> ({t('ui.optional')})</span> : null}
      </label>
      <div className={cx('field-control', unit != null && 'has-unit')}>
        {children({
          id,
          'aria-describedby': describedBy || undefined,
          'aria-invalid': error ? true : undefined,
        })}
        {unit != null ? <span className="field-unit">{unit}</span> : null}
      </div>
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('input', className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx('select', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('textarea', className)} {...rest} />;
}

interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  hint?: ReactNode;
}

/** Case à cocher : toute la ligne se touche. */
export function Checkbox({ label, hint, className, ...rest }: ChoiceProps) {
  return (
    <label className={cx('check', className)}>
      <input type="checkbox" {...rest} />
      <span className="check-text">
        <span>{label}</span>
        {hint ? <span className="check-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Bouton radio isolé ; pour un petit choix exclusif, préférer `Segmented`. */
export function Radio({ label, hint, className, ...rest }: ChoiceProps) {
  return (
    <label className={cx('check', className)}>
      <input type="radio" {...rest} />
      <span className="check-text">
        <span>{label}</span>
        {hint ? <span className="check-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Interrupteur (réglage qui prend effet tout de suite). */
export function Switch({ label, className, ...rest }: Omit<ChoiceProps, 'hint'>) {
  return (
    <label className={cx('switch-row', className)}>
      <span>{label}</span>
      <input type="checkbox" role="switch" className="switch" {...rest} />
    </label>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

export interface SegmentedProps<T extends string> {
  /** Nom accessible du groupe. */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  name?: string;
  className?: string;
}

/** Contrôle segmenté : groupe de radios présenté en bascule (filtre d'état, moyen de paiement…). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
  className,
}: SegmentedProps<T>) {
  const generated = useId();
  const group = name ?? generated;
  return (
    <div role="radiogroup" aria-label={label} className={cx('segmented', className)}>
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={group}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
