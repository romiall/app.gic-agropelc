/**
 * « Noter un échange » depuis la fiche d'un compte (ECR-CRM-03 : historique des échanges ; UC-CRM-04).
 * Canal (appel, SMS, courriel, autre ; WhatsApp et Kommo ne se saisissent pas, BR-CRM-017), sens,
 * résumé et prochaine action. Commande `crm.interaction.record` (agrégat `INTERACTION`, identifiant
 * choisi par l'appareil), utilisable hors ligne ; non modifiable ensuite (BR-CRM-016).
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import {
  ActionBar,
  BackLink,
  Banner,
  Button,
  Field,
  Input,
  PageHeader,
  Segmented,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
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
import './crm.css';

const DIRECTIONS = ['SORTANT', 'ENTRANT'] as const;

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

  if (!refs || !userId) {
    return (
      <section className="sale crm-screen" aria-busy="true">
        <PageHeader title={t('interaction.title')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const customer = refs.customers.find((candidate) => candidate.id === customerId);
  const backTo = customer ? ROUTES.customer(customer.id) : ROUTES.portfolio;
  const backLabel = customer ? t('interaction.back') : t('customer.back');
  if (!customer || customer.stage === 'MERGED') {
    return (
      <section className="sale crm-screen">
        <BackLink to={backTo}>{backLabel}</BackLink>
        <Banner tone="bad">{t('customer.not_found')}</Banner>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale crm-screen">
        <PageHeader
          title={t('interaction.title')}
          subtitle={customer.display_name}
          backTo={backTo}
          backLabel={backLabel}
        />
        <CommandResult commandId={submitted} messages="interaction.result">
          <Button
            variant="outline"
            onClick={() => {
              setDraft(EMPTY_INTERACTION);
              setSubmitted(undefined);
            }}
          >
            {t('interaction.another')}
          </Button>
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
    <section className="sale crm-screen">
      <PageHeader
        title={t('interaction.title')}
        subtitle={customer.display_name}
        backTo={backTo}
        backLabel={backLabel}
      />
      {!online ? (
        <Banner tone="warn" role="status">
          {t('interaction.offline_banner')}
        </Banner>
      ) : null}
      <div className="field">
        <span className="field-label">{t('interaction.channel_label')}</span>
        <Segmented
          label={t('interaction.channel_label')}
          value={draft.channel}
          onChange={(channel) => update({ channel })}
          options={INTERACTION_CHANNELS.map((channel) => ({
            value: channel,
            label: t(`customer.channel.${channel}`),
          }))}
        />
      </div>
      <div className="field">
        <span className="field-label">{t('interaction.direction_label')}</span>
        <Segmented
          label={t('interaction.direction_label')}
          value={draft.direction}
          onChange={(direction) => update({ direction })}
          options={DIRECTIONS.map((direction) => ({
            value: direction,
            label: t(`interaction.direction.${direction}`),
          }))}
        />
      </div>
      <Field label={t('interaction.summary_label')}>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={MAX_INTERACTION_SUMMARY}
            value={draft.summary}
            onChange={(event) => update({ summary: event.target.value })}
          />
        )}
      </Field>
      <div className="crm-pair">
        <Field label={t('visit.next_action_at_label')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              min={today}
              value={draft.nextActionAt}
              onChange={(event) => update({ nextActionAt: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('visit.next_action_note_label')}>
          {(control) => (
            <Input
              {...control}
              maxLength={MAX_NEXT_ACTION_NOTE}
              value={draft.nextActionNote}
              onChange={(event) => update({ nextActionNote: event.target.value })}
            />
          )}
        </Field>
      </div>
      {issues.includes('CHANNEL_REQUIRED') && draft.summary ? (
        <p className="field-error">{t('interaction.issue.CHANNEL_REQUIRED')}</p>
      ) : null}
      {issues.includes('NEXT_ACTION_PAST') ? (
        <p className="field-error">{t('visit.issue.NEXT_ACTION_PAST')}</p>
      ) : null}
      {!holdsAnyRole(roles, ROLE_SETS.interactionRecord) ? (
        <Banner tone="warn" role="status">
          {t('interaction.role_hint')}
        </Banner>
      ) : null}
      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
      <ActionBar>
        <Button
          size="lg"
          className="submit-sale"
          disabled={!ready}
          loading={busy}
          onClick={() => void submit()}
        >
          {busy ? t('sales.submitting') : t('interaction.submit')}
        </Button>
      </ActionBar>
    </section>
  );
}
