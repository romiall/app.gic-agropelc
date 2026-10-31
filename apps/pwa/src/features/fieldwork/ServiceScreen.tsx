/**
 * ECR-TER-01 « PRENDRE SERVICE / FIN DE SERVICE » (WF-J1, étapes 2 et 9 ; UC-TER-01 à 03). La
 * position est relevée à l'ouverture, et de nouveau après chaque pointage ; la zone proposée est
 * celle dont le géorepère la contient. Toute tentative est enregistrée (`fieldwork.checkin.record`,
 * hors ligne) ; une prise acceptée sur l'appareil ouvre aussitôt la session, qui rattache les visites.
 * En service, une prise dans une autre zone clôt la session en cours (BR-TER-009). Après des refus
 * répétés, une dérogation motivée ouvre une session en attente de validation
 * (`fieldwork.checkin.request_override`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf, type CheckinResult } from '@gic/domain';
import {
  ActionBar,
  Banner,
  Button,
  Field,
  LinkButton,
  List,
  ListRow,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useGeolocation } from '../../platform/useGeolocation.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { zonePathLabel } from '../crm/prospect.js';
import { formatClockTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { openWorkSession } from '../sales/pricing.js';
import { useSalesReferences } from '../sales/references.js';
import { settingValue } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import {
  checkinPayload,
  DEFAULT_MAX_GPS_ACCURACY_M,
  DEFAULT_OVERRIDE_MIN_ATTEMPTS,
  DEFAULT_OVERRIDE_MIN_MINUTES,
  evaluateAt,
  MAX_OVERRIDE_REASON_LENGTH,
  overrideAllowed,
  serviceZones,
  todayAttempts,
  zoneAt,
} from './service.js';
import './fieldwork.css';

type LastAction = 'START' | 'ATTEMPT' | 'END' | 'OVERRIDE';

const numberSetting = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value !== null && Number.isFinite(parsed) ? parsed : fallback;
};

const meters = (value: number | null | undefined): string | number =>
  value === null || value === undefined ? '?' : Math.round(value);

export function ServiceScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const geo = useGeolocation();
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<{ commandId: string; action: LastAction }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale fw-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.service')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const now = clock.now();
  const today = businessDayOf(now);
  const zones = serviceZones(
    refs.zones,
    numberSetting(
      settingValue(refs.settings, 'fieldwork.max_gps_accuracy_m', undefined, now),
      DEFAULT_MAX_GPS_ACCURACY_M,
    ),
  );
  const session = openWorkSession(refs.workSessions, userId, now);
  const attempts = todayAttempts(refs.outbox, userId, today);
  const locating = geo.state === 'locating';
  const position = locating ? null : geo.position;
  const zoneName = (id: string): string => {
    const zone = refs.zones.get(id);
    return zone ? zonePathLabel(refs.zones, zone) : '';
  };
  const autoZone = position ? zoneAt(position, zones) : undefined;
  const lastZoneId = session?.declared_zone_id ?? attempts[0]?.zoneId;
  const zoneId =
    zoneChoice ??
    autoZone?.zone.id ??
    (zones.some((zone) => zone.zone.id === lastZoneId) ? lastZoneId : undefined) ??
    '';
  const zone = zones.find((candidate) => candidate.zone.id === zoneId);
  const evaluation = zone ? evaluateAt(position, zone) : null;
  const minAttempts = numberSetting(
    settingValue(refs.settings, 'fieldwork.override_min_attempts', undefined, now),
    DEFAULT_OVERRIDE_MIN_ATTEMPTS,
  );
  const minMinutes = numberSetting(
    settingValue(refs.settings, 'fieldwork.override_min_minutes', undefined, now),
    DEFAULT_OVERRIDE_MIN_MINUTES,
  );
  const canOverride = overrideAllowed(attempts, minAttempts, minMinutes);
  const roles = navigation ? navigation.roles : [];
  // Garde contre une seconde saisie tant que la commande envoyée n'est pas visible dans l'outbox.
  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last.commandId);
  const blocked = busy || settling;

  const send = async (action: LastAction, input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, action });
      if (action === 'OVERRIDE') setReason('');
      // Chaque pointage part sur une position fraîche : la suivante sera relevée de nouveau.
      if (action !== 'OVERRIDE') {
        setZoneChoice(null);
        geo.reset();
      }
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!zone || !evaluation || locating) return;
    const accepted = evaluation.result === 'ACCEPTED';
    void send(accepted ? 'START' : 'ATTEMPT', {
      authorUserId: userId,
      commandType: 'fieldwork.checkin.record',
      aggregateType: 'GEO_CHECKIN',
      payload: checkinPayload({
        checkinType: 'START_SERVICE',
        zoneId: zone.zone.id,
        position,
        clientResult: evaluation.result,
        // Prise acceptée sur l'appareil : la session s'ouvre sous cet identifiant, repris par le serveur.
        ...(accepted ? { sessionId: idGenerator.newId() } : {}),
      }),
    });
  };

  const end = () => {
    if (!session || locating) return;
    const sessionZone = zones.find((candidate) => candidate.zone.id === session.declared_zone_id);
    // Fin hors zone : signalée, jamais bloquante (BR-TER-007).
    const result: CheckinResult = sessionZone
      ? evaluateAt(position, sessionZone).result
      : position
        ? 'REJECTED_OUT_OF_ZONE'
        : 'NO_POSITION';
    // Pas de dépendance vers la prise : l'ordre du lot suffit, et les visites saisies après la fin
    // ne doivent pas partir avant elle (ADR-037 §11).
    void send('END', {
      authorUserId: userId,
      commandType: 'fieldwork.checkin.record',
      aggregateType: 'GEO_CHECKIN',
      payload: checkinPayload({
        checkinType: 'END_SERVICE',
        zoneId: session.declared_zone_id,
        position,
        clientResult: result,
        sessionId: session.id,
      }),
    });
  };

  const requestOverride = () => {
    if (!zone || !reason.trim()) return;
    void send('OVERRIDE', {
      authorUserId: userId,
      commandType: 'fieldwork.checkin.request_override',
      aggregateType: 'WORK_SESSION',
      payload: { declaredZoneId: zone.zone.id, reason: reason.trim() },
    });
  };

  const locateButton = (
    <Button variant="outline" onClick={geo.locate} disabled={locating}>
      {locating ? t('service.locating') : t('service.locate')}
    </Button>
  );

  return (
    <section className="sale fw-screen">
      <PageHeader title={t('nav.screens.service')} />
      {!online ? (
        <Banner tone="warn" role="status">
          {t('service.offline_banner')}
        </Banner>
      ) : null}
      {last ? (
        <CommandResult commandId={last.commandId} messages={`service.result_${last.action}`} />
      ) : null}

      {session ? (
        <Section title={t('service.in_service_title')}>
          <div className="status-card">
            <div className="status-card-text">
              <p>
                {t('service.in_service', {
                  zone: zoneName(session.declared_zone_id),
                  time: formatClockTime(session.started_at),
                })}
              </p>
              {session.auto_close && session.ended_at ? (
                <p className="muted">
                  {t('service.auto_close', { time: formatClockTime(session.ended_at) })}
                </p>
              ) : null}
            </div>
            <Button variant="outline" disabled={blocked || locating} onClick={end}>
              {busy ? t('sales.submitting') : t('service.end')}
            </Button>
          </div>
          {session.override_status === 'PENDING' ? (
            <Banner tone="warn" role="status">
              {t('service.override_pending')}
            </Banner>
          ) : null}
          {session.override_status === 'REJECTED' ? (
            <Banner tone="warn" role="status">
              {t('service.override_rejected')}
            </Banner>
          ) : null}
          <p className="muted">
            {locating
              ? t('service.locating')
              : position
                ? t('service.position_value', { accuracy: meters(position.accuracyM) })
                : t('service.gps_unavailable_end')}
          </p>
          <div className="result-actions">
            {locateButton}
            {holdsAnyRole(roles, ROLE_SETS.visitRecord) ? (
              <LinkButton to={ROUTES.newVisit} variant="tonal" icon="store">
                {t('nav.screens.new_visit')}
              </LinkButton>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section title={session ? t('service.change_zone_title') : t('service.start_title')}>
        {session ? (
          <p className="muted">
            {t('service.start_supersedes', { zone: zoneName(session.declared_zone_id) })}
          </p>
        ) : null}
        {zones.length === 0 ? (
          <Banner tone="bad">{t('service.no_zone')}</Banner>
        ) : (
          <Field label={t('service.zone_label')}>
            {(control) => (
              <Select
                {...control}
                value={zoneId}
                onChange={(event) => setZoneChoice(event.target.value || null)}
              >
                <option value="">{t('service.zone_placeholder')}</option>
                {zones.map((candidate) => (
                  <option key={candidate.zone.id} value={candidate.zone.id}>
                    {zonePathLabel(refs.zones, candidate.zone)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="field">
          <span className="field-label">{t('service.position_label')}</span>
          <div className="fw-locate">
            {locating ? (
              <p>{t('service.locating')}</p>
            ) : evaluation && zone ? (
              <p className={evaluation.result === 'ACCEPTED' ? undefined : 'is-warn'} role="status">
                {t(`service.evaluation.${evaluation.result}`, {
                  distance: Math.round(evaluation.distanceM ?? 0),
                  radius: zone.geofence.radiusM,
                  accuracy: meters(position?.accuracyM),
                  max: zone.maxAccuracyM,
                })}
              </p>
            ) : !position ? (
              <p className="is-warn">{t('service.gps_unavailable')}</p>
            ) : null}
            {locateButton}
          </div>
        </div>
        {!holdsAnyRole(roles, ROLE_SETS.fieldwork) ? (
          <Banner tone="warn" role="status">
            {t('service.role_hint')}
          </Banner>
        ) : null}
        {canOverride && zone ? (
          <div className="fw-override">
            <Field label={t('service.override_label')} hint={t('service.override_hint')}>
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  maxLength={MAX_OVERRIDE_REASON_LENGTH}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </Field>
            <Button
              variant="outline"
              disabled={!reason.trim() || blocked}
              onClick={requestOverride}
            >
              {t('service.override_submit')}
            </Button>
          </div>
        ) : null}
        {session ? (
          <Button variant="outline" block disabled={!zone || blocked || locating} onClick={start}>
            {busy ? t('sales.submitting') : t('service.change_zone')}
          </Button>
        ) : (
          <ActionBar>
            <Button
              size="lg"
              className="submit-sale"
              disabled={!zone || blocked || locating}
              loading={busy}
              onClick={start}
            >
              {busy ? t('sales.submitting') : t('service.start')}
            </Button>
          </ActionBar>
        )}
      </Section>

      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}

      <Section title={t('service.attempts_title')}>
        {attempts.length === 0 ? (
          <p className="muted">{t('service.no_attempt')}</p>
        ) : (
          <List>
            {attempts.map((attempt) => (
              <ListRow
                key={attempt.commandId}
                icon={attempt.type === 'START_SERVICE' ? 'clock' : 'check-circle'}
                title={t(`service.type.${attempt.type}`)}
                subtitle={
                  <>
                    {zoneName(attempt.zoneId)} ·{' '}
                    {t(`service.attempt_result.${attempt.clientResult}`)}
                  </>
                }
                value={formatClockTime(attempt.occurredAt)}
              />
            ))}
          </List>
        )}
      </Section>
    </section>
  );
}
