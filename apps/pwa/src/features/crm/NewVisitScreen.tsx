/**
 * ECR-CRM-04 « + VISITE » (UC-CRM-03 ; WF-J1, étape 4). Le commercial choisit le compte (ou arrive
 * de sa fiche), la position est relevée dès l'ouverture, il note le résultat (obligatoire), un
 * commentaire et la prochaine action. Commande `crm.visit.record` (agrégat `VISIT`, identifiant
 * choisi par l'appareil), utilisable hors ligne. Les signalements du serveur (hors session, loin du
 * compte) sont annoncés avant l'envoi. Un compte sans position reçoit celle de la visite si elle est
 * précise (BR-CRM-014, `crm.customer.update`).
 */
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useGeolocation } from '../../platform/useGeolocation.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { CustomerPicker } from '../sales/CustomerPicker.js';
import { openWorkSession } from '../sales/pricing.js';
import { useSalesReferences } from '../sales/references.js';
import { settingValue } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import {
  checkVisit,
  customerPositionPayload,
  DEFAULT_VISIT_MAX_DISTANCE_M,
  EMPTY_VISIT,
  MAX_NEXT_ACTION_NOTE,
  MAX_VISIT_NOTES,
  proposesCustomerPosition,
  visitOutcomes,
  visitPayload,
  type VisitDraft,
} from './visit.js';

export function NewVisitScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const [searchParams] = useSearchParams();
  const [draft, setDraft] = useState<VisitDraft>(() => ({
    ...EMPTY_VISIT,
    customerId: searchParams.get('client'),
  }));
  const [submitted, setSubmitted] = useState<{ visit: string; customerId: string }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const notesId = useId();
  const nextAtId = useId();
  const nextNoteId = useId();

  const update = (patch: Partial<VisitDraft>) => setDraft((current) => ({ ...current, ...patch }));

  // Visite géolocalisée (03-parcours-et-ecrans.md, WF-J1) : la position est relevée à l'ouverture.
  const geo = useGeolocation();
  // La position de la visite est la dernière relevée.
  const effective: VisitDraft = { ...draft, position: geo.position };

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.new_visit')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.new_visit')}</h1>
        <CommandResult commandId={submitted.visit} messages="visit.result">
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY_VISIT);
              setSubmitted(undefined);
              // Nouvelle visite, nouveau lieu : la position précédente n'est jamais reprise.
              geo.reset();
            }}
          >
            {t('visit.another')}
          </button>
          <Link to={ROUTES.customer(submitted.customerId)} className="action action-compact">
            <span className="action-label">{t('visit.to_customer')}</span>
          </Link>
        </CommandResult>
      </section>
    );
  }

  const now = clock.now();
  const today = businessDayOf(now);
  const customers = refs.customers.filter((customer) => customer.stage !== 'MERGED');
  const customer = customers.find((candidate) => candidate.id === draft.customerId);
  const session = openWorkSession(refs.workSessions, userId, now);
  const maxDistanceM = Number(
    settingValue(refs.settings, 'crm.visit.max_distance_m', undefined, now) ??
      DEFAULT_VISIT_MAX_DISTANCE_M,
  );
  const check = checkVisit(effective, {
    customer,
    session,
    maxDistanceM: Number.isFinite(maxDistanceM) ? maxDistanceM : DEFAULT_VISIT_MAX_DISTANCE_M,
    today,
  });
  const outcomes = visitOutcomes(refs.reasonCodes);
  // Pas de proposition pendant un relevé : la position affichée pourrait être l'ancienne.
  const proposePosition =
    geo.state !== 'locating' &&
    proposesCustomerPosition(customer, effective.position, refs.outbox, refs.customersPulledAt);
  const roles = navigation ? navigation.roles : [];
  const ready = check.issues.length === 0 && outcomes.length > 0 && !busy;

  const submit = async () => {
    if (!ready || !customer) return;
    setBusy(true);
    setSaveError(false);
    try {
      const dependsOn = customer.pending_command_id ? [customer.pending_command_id] : [];
      const visit = await submitCommand({
        authorUserId: userId,
        commandType: 'crm.visit.record',
        aggregateType: 'VISIT',
        dependsOn,
        payload: visitPayload(effective),
      });
      if (proposePosition && draft.saveCustomerPosition && effective.position) {
        try {
          await submitCommand({
            authorUserId: userId,
            commandType: 'crm.customer.update',
            aggregateType: 'CUSTOMER',
            aggregateId: customer.id,
            // Compte créé sur l'appareil : pas encore de version servie.
            baseVersion: customer.pending_command_id ? null : customer.version,
            dependsOn,
            payload: customerPositionPayload(effective.position),
          });
        } catch {
          // La visite est enregistrée ; la position du compte sera proposée à la prochaine visite.
        }
      }
      setSubmitted({ visit: visit.command_id, customerId: customer.id });
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.new_visit')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('visit.offline_banner')}
        </p>
      ) : null}
      {check.flags.includes('OUT_OF_SESSION') ? (
        <p className="text-warn">
          {t('visit.out_of_session')} <Link to={ROUTES.service}>{t('visit.take_service')}</Link>
        </p>
      ) : null}
      {check.flags.includes('SESSION_REJECTED') ? (
        <p className="text-warn">{t('visit.session_rejected')}</p>
      ) : null}

      <div className="sale-block">
        <h2>{t('visit.customer_title')}</h2>
        <CustomerPicker
          customers={customers}
          value={draft.customerId}
          onChange={(customerId) => update({ customerId })}
          allowAnonymous={false}
        />
      </div>

      <div className="field">
        <span className="field-label">{t('visit.position_label')}</span>
        {effective.position ? (
          <p className="home-muted">
            {t('visit.position_value', {
              accuracy:
                effective.position.accuracyM === null
                  ? '?'
                  : Math.round(effective.position.accuracyM),
            })}
          </p>
        ) : geo.state === 'unavailable' ? (
          <p className="text-warn">{t('visit.gps_unavailable')}</p>
        ) : null}
        {check.flags.includes('FAR_FROM_CUSTOMER') && check.distanceToCustomerM !== null ? (
          <p className="text-warn">
            {t('visit.far_from_customer', {
              distance: Math.round(check.distanceToCustomerM),
              max: maxDistanceM,
            })}
          </p>
        ) : null}
        <button
          type="button"
          className="secondary"
          onClick={geo.locate}
          disabled={geo.state === 'locating'}
        >
          {geo.state === 'locating' ? t('visit.locating') : t('visit.locate')}
        </button>
        {proposePosition ? (
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.saveCustomerPosition}
              onChange={(event) => update({ saveCustomerPosition: event.target.checked })}
            />
            {t('visit.save_customer_position')}
          </label>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="visit-outcome">{t('visit.outcome_label')}</label>
        {outcomes.length === 0 ? (
          <p className="alert alert-error" role="alert">
            {t('visit.no_outcomes')}
          </p>
        ) : (
          <select
            id="visit-outcome"
            className="text-input"
            value={draft.outcomeId}
            onChange={(event) => update({ outcomeId: event.target.value })}
          >
            <option value="">{t('visit.outcome_placeholder')}</option>
            {outcomes.map((reason) => (
              <option key={reason.id} value={reason.id}>
                {reason.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="field">
        <label htmlFor={notesId}>{t('visit.notes_label')}</label>
        <textarea
          id={notesId}
          className="text-input"
          rows={3}
          maxLength={MAX_VISIT_NOTES}
          value={draft.notes}
          onChange={(event) => update({ notes: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={nextAtId}>{t('visit.next_action_at_label')}</label>
        <input
          id={nextAtId}
          type="date"
          className="text-input"
          min={today}
          value={draft.nextActionAt}
          onChange={(event) => update({ nextActionAt: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={nextNoteId}>{t('visit.next_action_note_label')}</label>
        <input
          id={nextNoteId}
          className="text-input"
          maxLength={MAX_NEXT_ACTION_NOTE}
          value={draft.nextActionNote}
          onChange={(event) => update({ nextActionNote: event.target.value })}
        />
      </div>

      {check.issues.includes('NEXT_ACTION_PAST') ? (
        <p className="error-message">{t('visit.issue.NEXT_ACTION_PAST')}</p>
      ) : null}
      {!holdsAnyRole(roles, ROLE_SETS.visitRecord) ? (
        <p className="text-warn">{t('visit.role_hint')}</p>
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <button
        type="button"
        className="btn-block submit-sale"
        disabled={!ready}
        onClick={() => void submit()}
      >
        {busy ? t('sales.submitting') : t('visit.submit')}
      </button>
    </section>
  );
}
