/**
 * ECR-CRM-02 « + PROSPECT » (UC-CRM-01 ; WF-J1). Un écran, peu de champs obligatoires (UX-02) :
 * nom, téléphone ou position GPS (BR-CRM-002), zone (préremplie : zone du point de vente, sinon zone
 * de la session de travail), source (préremplie). Le doublon de téléphone est signalé avant l'envoi
 * (BR-CRM-006). Commande `crm.customer.create` (agrégat `CUSTOMER`, identifiant choisi par
 * l'appareil), utilisable hors ligne ; le compte est aussitôt proposé à la vente, qui dépendra de sa
 * création.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Banner,
  Button,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { openWorkSession } from '../sales/pricing.js';
import { useSalesReferences } from '../sales/references.js';
import { sellingLocations } from '../sales/sale-form.js';
import { settingValue } from '../sales/stock.js';
import { phaseOf, submitCommand, useOutboxCommand } from '../sales/submit.js';
import {
  checkProspect,
  CUSTOMER_TYPES,
  DEFAULT_COUNTRY_CODE,
  LEAD_SOURCES,
  prospectPayload,
  prospectZoneOptions,
  type Position,
  type ProspectDraft,
} from './prospect.js';
import './crm.css';

const GPS_TIMEOUT_MS = 15_000;

const EMPTY: ProspectDraft = {
  displayName: '',
  phone: '',
  position: null,
  zoneId: '',
  sourceCode: '',
  customerType: 'PARTICULIER',
  contactName: '',
  businessActivity: '',
  addressText: '',
  categoryId: '',
};

type GpsState = 'idle' | 'locating' | 'denied';

/** « Vendre à ce client », client déjà choisi ; pas proposé si la création est refusée ou en conflit. */
function SellToProspect({ commandId, customerId }: { commandId: string; customerId: string }) {
  const { t } = useTranslation();
  const command = useOutboxCommand(commandId);
  if (!command) return null;
  const phase = phaseOf(command);
  if (phase === 'REJECTED' || phase === 'CONFLICT') return null;
  return (
    <LinkButton to={ROUTES.newSaleFor(customerId)} icon="cart">
      {t('prospect.to_sale')}
    </LinkButton>
  );
}

export function NewProspectScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const [draft, setDraft] = useState<ProspectDraft>(EMPTY);
  const [gps, setGps] = useState<GpsState>('idle');
  const [submitted, setSubmitted] = useState<{ commandId: string; customerId: string }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale crm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.new_prospect')} />
        <SkeletonRows rows={4} />
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale crm-screen">
        <PageHeader title={t('nav.screens.new_prospect')} />
        <CommandResult commandId={submitted.commandId} messages="prospect.result">
          <SellToProspect commandId={submitted.commandId} customerId={submitted.customerId} />
          <Button
            variant="outline"
            onClick={() => {
              setDraft(EMPTY);
              setSubmitted(undefined);
            }}
          >
            {t('prospect.another')}
          </Button>
        </CommandResult>
      </section>
    );
  }

  const now = clock.now();
  const update = (patch: Partial<ProspectDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const zones = prospectZoneOptions(refs.zones);
  // Zone préremplie : celle du point de vente de l'utilisateur, sinon celle de sa session de travail.
  const ownLocation = sellingLocations(refs, userId)[0];
  const ownSite = ownLocation?.site_id ? refs.sites.get(ownLocation.site_id) : undefined;
  const session = openWorkSession(refs.workSessions, userId, now);
  const defaultZone =
    ownLocation?.location_type === 'POS' ? ownSite?.zone_id : session?.declared_zone_id;
  // Une zone préremplie ou choisie qui n'est plus proposée (inactive) n'est jamais envoyée.
  const offered = (id: string | undefined) => id !== undefined && zones.some((z) => z.id === id);
  const zoneId = offered(draft.zoneId)
    ? draft.zoneId
    : offered(defaultZone)
      ? (defaultZone as string)
      : '';
  const defaultSource =
    ownLocation?.location_type === 'POS' ? 'VISITE_SPONTANEE' : 'PROSPECTION_TERRAIN';
  const sourceCode = draft.sourceCode || defaultSource;
  const countryCode = String(
    settingValue(refs.settings, 'crm.phone_default_country_code', ownSite?.id, now) ??
      DEFAULT_COUNTRY_CODE,
  );
  const effective = { ...draft, zoneId, sourceCode };
  const check = checkProspect(effective, refs.customers, countryCode);
  const roles = navigation ? navigation.roles : [];
  // Un compte sans titulaire (vendeur de PDV, pas de rôle commercial) se rattache à son site.
  const commercial = roles.some((role) =>
    ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'].includes(role),
  );
  const homeSiteId = !commercial && ownSite ? ownSite.id : undefined;
  const duplicateBlocks = online && check.duplicateOf !== null;
  const ready = check.issues.length === 0 && !duplicateBlocks && !busy;
  const categories = refs.customerCategories;

  const locate = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGps('denied');
      return;
    }
    setGps('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const value: Position = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy)
            ? Math.round(position.coords.accuracy)
            : null,
        };
        update({ position: value });
        setGps('idle');
      },
      () => setGps('denied'),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS },
    );
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'crm.customer.create',
        aggregateType: 'CUSTOMER',
        payload: prospectPayload(effective, homeSiteId ? { homeSiteId } : {}),
      });
      setSubmitted({ commandId: command.command_id, customerId: command.aggregate_id });
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale crm-screen">
      <PageHeader title={t('nav.screens.new_prospect')} />
      {!online ? (
        <Banner tone="warn" role="status">
          {t('prospect.offline_banner')}
        </Banner>
      ) : null}
      <Field label={t('prospect.name_label')}>
        {(control) => (
          <Input
            {...control}
            maxLength={200}
            value={draft.displayName}
            onChange={(event) => update({ displayName: event.target.value })}
            autoComplete="off"
          />
        )}
      </Field>
      <Field
        label={t('prospect.phone_label')}
        hint={
          check.normalizedPhone
            ? t('prospect.phone_normalized', { phone: check.normalizedPhone })
            : undefined
        }
      >
        {(control) => (
          <Input
            {...control}
            type="tel"
            inputMode="tel"
            maxLength={30}
            value={draft.phone}
            onChange={(event) => update({ phone: event.target.value })}
            autoComplete="off"
          />
        )}
      </Field>
      <div className="field">
        <span className="field-label">{t('prospect.position_label')}</span>
        <div className="crm-locate">
          {draft.position ? (
            <p>
              {t('prospect.position_value', {
                lat: draft.position.lat.toFixed(5),
                lng: draft.position.lng.toFixed(5),
                accuracy: draft.position.accuracyM ?? '?',
              })}
            </p>
          ) : null}
          <Button variant="outline" onClick={locate} disabled={gps === 'locating'}>
            {gps === 'locating' ? t('prospect.locating') : t('prospect.locate')}
          </Button>
        </div>
        {gps === 'denied' ? (
          <Banner tone="warn" role="status">
            {t('prospect.gps_denied')}
          </Banner>
        ) : null}
      </div>
      <div className="crm-pair">
        <Field label={t('prospect.zone_label')}>
          {(control) => (
            <Select
              {...control}
              value={zoneId}
              onChange={(event) => update({ zoneId: event.target.value })}
            >
              <option value="">{t('prospect.zone_placeholder')}</option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('prospect.source_label')}>
          {(control) => (
            <Select
              {...control}
              value={sourceCode}
              onChange={(event) => update({ sourceCode: event.target.value })}
            >
              {LEAD_SOURCES.map((code) => (
                <option key={code} value={code}>
                  {t(`prospect.sources.${code}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <details className="crm-more">
        <summary>{t('prospect.more')}</summary>
        <div className="crm-more-body">
          <div className="field">
            <span className="field-label">{t('prospect.type_label')}</span>
            <Segmented
              label={t('prospect.type_label')}
              value={draft.customerType}
              onChange={(customerType) => update({ customerType })}
              options={CUSTOMER_TYPES.map((type) => ({
                value: type,
                label: t(`prospect.types.${type}`),
              }))}
            />
          </div>
          <Field label={t('prospect.contact_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                value={draft.contactName}
                onChange={(event) => update({ contactName: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('prospect.activity_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                value={draft.businessActivity}
                onChange={(event) => update({ businessActivity: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('prospect.address_label')}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={2000}
                value={draft.addressText}
                onChange={(event) => update({ addressText: event.target.value })}
              />
            )}
          </Field>
          {categories.length > 0 ? (
            <Field label={t('prospect.category_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={draft.categoryId}
                  onChange={(event) => update({ categoryId: event.target.value })}
                >
                  <option value="">{t('prospect.category_none')}</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
      </details>

      {check.duplicateOf ? (
        <Banner tone={online ? 'bad' : 'warn'} role="alert">
          {t(online ? 'prospect.duplicate_online' : 'prospect.duplicate_offline', {
            name: check.duplicateOf.display_name,
          })}
        </Banner>
      ) : null}
      {draft.displayName || draft.phone
        ? check.issues.map((issue) => (
            <p key={issue} className="field-error">
              {t(`prospect.issue.${issue}`)}
            </p>
          ))
        : null}
      {!holdsAnyRole(roles, ROLE_SETS.customerCreate) ? (
        <Banner tone="warn" role="status">
          {t('prospect.role_hint')}
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
          {busy ? t('sales.submitting') : t('prospect.submit')}
        </Button>
      </ActionBar>
    </section>
  );
}
