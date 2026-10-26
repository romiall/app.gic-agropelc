/**
 * Rendu du titre et du message d'une alerte (P9 ; ADR-071 §11, ADR-072 §4 ; AV-440 ; RC-05, BR-ANA-004).
 *
 * Le message est **rendu pour un lecteur** : une valeur au coût (champ `protected` du catalogue) n'y
 * figure que si le lecteur détient `inventory.valuation.read` sur le site de l'alerte ; sinon le message
 * est neutre, sans mention de la valeur. Le rendu n'est jamais stocké dans `alerts.message` : seule la
 * charge utile (champs séparés) est conservée.
 */
import { businessDayOf } from './business-day.js';
import {
  alertDefinitionOf,
  type AlertEventPayload,
  type AlertFieldKind,
  type AlertMessageField,
  type AlertType,
} from './alerts.js';

export interface RenderedAlertMessage {
  readonly title: string;
  readonly message: string;
}

export interface RenderAlertMessageOptions {
  /** Le lecteur détient `inventory.valuation.read` sur le site de l'alerte. */
  readonly showProtected: boolean;
}

const NON_BREAKING = /[\u00a0\u202f]/g;

function groupThousands(value: number): string {
  return value.toLocaleString('fr-FR').replace(NON_BREAKING, ' ');
}

function formatValue(kind: AlertFieldKind, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  switch (kind) {
    case 'text':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value).trim() || null
        : null;
    case 'xaf': {
      const numeric = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numeric) ? `${groupThousands(Math.round(numeric))} XAF` : null;
    }
    case 'quantity': {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) return null;
      return (Math.round(numeric * 1000) / 1000).toLocaleString('fr-FR').replace(NON_BREAKING, ' ');
    }
    case 'integer': {
      const numeric = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numeric) ? String(Math.trunc(numeric)) : null;
    }
    case 'hours': {
      const numeric = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numeric) ? `${Math.trunc(numeric)} h` : null;
    }
    case 'date': {
      if (typeof value !== 'string' || value.trim() === '') return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      const instant = new Date(value);
      return Number.isNaN(instant.getTime()) ? null : businessDayOf(instant);
    }
  }
}

function renderField(field: AlertMessageField, payload: AlertEventPayload): string | null {
  const text = formatValue(field.kind ?? 'text', payload[field.key]);
  return text === null ? null : `${field.label} : ${text}`;
}

/**
 * Titre et message d'un type d'alerte pour une charge utile. Les champs absents sont omis ; les champs
 * protégés sont omis sans le droit de valorisation (gabarit neutre).
 */
export function renderAlertMessage(
  type: AlertType,
  payload: AlertEventPayload,
  options: RenderAlertMessageOptions,
): RenderedAlertMessage {
  const definition = alertDefinitionOf(type);
  const parts: string[] = [];
  for (const field of definition.messageFields) {
    if (field.protected === true && !options.showProtected) continue;
    const rendered = renderField(field, payload);
    if (rendered !== null) parts.push(rendered);
  }
  return { title: definition.messageTitle, message: parts.join(' ; ') };
}

/** Le message rendu au lecteur contient-il une valeur protégée (la charge utile en porte-t-elle une) ? */
export function alertCarriesProtectedValue(type: AlertType, payload: AlertEventPayload): boolean {
  return alertDefinitionOf(type).messageFields.some(
    (field) =>
      field.protected === true && payload[field.key] !== undefined && payload[field.key] !== null,
  );
}
