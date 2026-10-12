/**
 * « Noter un échange » depuis la fiche d'un compte (ECR-CRM-03 : historique des échanges ; UC-CRM-04).
 * Canal (appel, SMS, courriel, autre ; WhatsApp et Kommo ne se saisissent pas, BR-CRM-017), sens,
 * résumé et prochaine action. Commande `crm.interaction.record` (agrégat `INTERACTION`, identifiant
 * choisi par l'appareil), utilisable hors ligne ; non modifiable ensuite (BR-CRM-016).
 */
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import {
  checkInteraction,
  EMPTY_INTERACTION,
  INTERACTION_CHANNELS,
  interactionPayload,
  MAX_INTERACTION_SUMMARY,
  type InteractionDraft,
} from './interaction.js';
import { MAX_NEXT_ACTION_NOTE } from './visit.js';

export function InteractionScreen() {
  const { t } = useTranslation();
  const { customerId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const [draft, setDraft] = useState<InteractionDraft>(EMPTY_INTERACTION);
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const summaryId = useId();
  const nextAtId = useId();
  const nextNoteId = useId();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('interaction.title')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const customer = refs.customers.find((candidate) => candidate.id === customerId);
  const back = customer ? (
    <Link to={ROUTES.customer(customer.id)} className="back-link">
      {t('interaction.back')}
    </Link>
  ) : (
    <Link to={ROUTES.portfolio} className="back-link">
      {t('customer.back')}
    </Link>
  );
  if (!customer || customer.stage === 'MERGED') {
    return (
      <section className="sale">
        {back}
        <p className="alert alert-error">{t('customer.not_found')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        {back}
        <h1>{t('interaction.title')}</h1>
        <CommandResult commandId={submitted} messages="interaction.result">
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY_INTERACTION);
              setSubmitted(undefined);
            }}
          >
            {t('interaction.another')}
          </button>
        </CommandResult>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const issues = checkInteraction(draft, today);
  const roles = navigation ? navigation.roles : [];
  const ready = issues.length === 0 && !busy;
  const update = (patch: Partial<InteractionDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'crm.interaction.record',
        aggregateType: 'INTERACTION',
        dependsOn: customer.pending_command_id ? [customer.pending_command_id] : [],
        payload: interactionPayload(customer.id, draft),
      });
      setSubmitted(command.command_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      {back}
      <h1>{t('interaction.title')}</h1>
      <p className="home-muted">{customer.display_name}</p>
      {!online ? (
        <p className="home-banner" role="status">
          {t('interaction.offline_banner')}
        </p>
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('interaction.channel_label')}</legend>
        {INTERACTION_CHANNELS.map((channel) => (
          <label key={channel} className="choice">
            <input
              type="radio"
              name="interaction-channel"
              value={channel}
              checked={draft.channel === channel}
              onChange={() => update({ channel })}
            />
            {t(`customer.channel.${channel}`)}
          </label>
        ))}
      </fieldset>
      <fieldset className="choice-group">
        <legend>{t('interaction.direction_label')}</legend>
        {(['SORTANT', 'ENTRANT'] as const).map((direction) => (
          <label key={direction} className="choice">
            <input
              type="radio"
              name="interaction-direction"
              value={direction}
              checked={draft.direction === direction}
              onChange={() => update({ direction })}
            />
            {t(`interaction.direction.${direction}`)}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={summaryId}>{t('interaction.summary_label')}</label>
        <textarea
          id={summaryId}
          className="text-input"
          rows={3}
          maxLength={MAX_INTERACTION_SUMMARY}
          value={draft.summary}
          onChange={(event) => update({ summary: event.target.value })}
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
      {issues.includes('CHANNEL_REQUIRED') && draft.summary ? (
        <p className="error-message">{t('interaction.issue.CHANNEL_REQUIRED')}</p>
      ) : null}
      {issues.includes('NEXT_ACTION_PAST') ? (
        <p className="error-message">{t('visit.issue.NEXT_ACTION_PAST')}</p>
      ) : null}
      {!holdsAnyRole(roles, ROLE_SETS.interactionRecord) ? (
        <p className="text-warn">{t('interaction.role_hint')}</p>
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
        {busy ? t('sales.submitting') : t('interaction.submit')}
      </button>
    </section>
  );
}
