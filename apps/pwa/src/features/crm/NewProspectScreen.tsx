/**
 * ECR-CRM-02 « + PROSPECT » (UC-CRM-01 ; WF-J1). Un écran, peu de champs obligatoires (UX-02) :
 * nom, téléphone ou position GPS (BR-CRM-002), zone (préremplie : zone du point de vente, sinon zone
 * de la session de travail), source (préremplie). Le doublon de téléphone est signalé avant l'envoi
 * (BR-CRM-006). Commande `crm.customer.create` (agrégat `CUSTOMER`, identifiant choisi par
 * l'appareil), utilisable hors ligne ; le compte est aussitôt proposé à la vente, qui dépendra de sa
 * création.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
    <Link to={ROUTES.newSaleFor(customerId)} className="action action-compact">
      <span className="action-label">{t('prospect.to_sale')}</span>
    </Link>
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
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.new_prospect')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.new_prospect')}</h1>
        <CommandResult commandId={submitted.commandId} messages="prospect.result">
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY);
              setSubmitted(undefined);
            }}
          >
            {t('prospect.another')}
          </button>
          <SellToProspect commandId={submitted.commandId} customerId={submitted.customerId} />
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
    <section className="sale">
      <h1>{t('nav.screens.new_prospect')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('prospect.offline_banner')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="prospect-name">{t('prospect.name_label')}</label>
        <input
          id="prospect-name"
          className="text-input"
          maxLength={200}
          value={draft.displayName}
          onChange={(event) => update({ displayName: event.target.value })}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor="prospect-phone">{t('prospect.phone_label')}</label>
        <input
          id="prospect-phone"
          className="text-input"
          type="tel"
          inputMode="tel"
          maxLength={30}
          value={draft.phone}
          onChange={(event) => update({ phone: event.target.value })}
          autoComplete="off"
        />
        {check.normalizedPhone ? (
          <p className="home-muted">
            {t('prospect.phone_normalized', { phone: check.normalizedPhone })}
          </p>
        ) : null}
      </div>
      <div className="field">
        <span className="field-label">{t('prospect.position_label')}</span>
        {draft.position ? (
          <p className="home-muted">
            {t('prospect.position_value', {
              lat: draft.position.lat.toFixed(5),
              lng: draft.position.lng.toFixed(5),
              accuracy: draft.position.accuracyM ?? '?',
            })}
          </p>
        ) : null}
        <button type="button" className="secondary" onClick={locate} disabled={gps === 'locating'}>
          {gps === 'locating' ? t('prospect.locating') : t('prospect.locate')}
        </button>
        {gps === 'denied' ? <p className="text-warn">{t('prospect.gps_denied')}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="prospect-zone">{t('prospect.zone_label')}</label>
        <select
          id="prospect-zone"
          className="text-input"
          value={zoneId}
          onChange={(event) => update({ zoneId: event.target.value })}
        >
          <option value="">{t('prospect.zone_placeholder')}</option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="prospect-source">{t('prospect.source_label')}</label>
        <select
          id="prospect-source"
          className="text-input"
          value={sourceCode}
          onChange={(event) => update({ sourceCode: event.target.value })}
        >
          {LEAD_SOURCES.map((code) => (
            <option key={code} value={code}>
              {t(`prospect.sources.${code}`)}
            </option>
          ))}
        </select>
      </div>

      <details className="sale-block">
        <summary>{t('prospect.more')}</summary>
        <div className="field">
          <label htmlFor="prospect-type">{t('prospect.type_label')}</label>
          <select
            id="prospect-type"
            className="text-input"
            value={draft.customerType}
            onChange={(event) =>
              update({ customerType: event.target.value as ProspectDraft['customerType'] })
            }
          >
            {CUSTOMER_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`prospect.types.${type}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="prospect-contact">{t('prospect.contact_label')}</label>
          <input
            id="prospect-contact"
            className="text-input"
            maxLength={200}
            value={draft.contactName}
            onChange={(event) => update({ contactName: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="prospect-activity">{t('prospect.activity_label')}</label>
          <input
            id="prospect-activity"
            className="text-input"
            maxLength={200}
            value={draft.businessActivity}
            onChange={(event) => update({ businessActivity: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="prospect-address">{t('prospect.address_label')}</label>
          <textarea
            id="prospect-address"
            className="text-input"
            rows={2}
            maxLength={2000}
            value={draft.addressText}
            onChange={(event) => update({ addressText: event.target.value })}
          />
        </div>
        {categories.length > 0 ? (
          <div className="field">
            <label htmlFor="prospect-category">{t('prospect.category_label')}</label>
            <select
              id="prospect-category"
              className="text-input"
              value={draft.categoryId}
              onChange={(event) => update({ categoryId: event.target.value })}
            >
              <option value="">{t('prospect.category_none')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </details>

      {check.duplicateOf ? (
        <p className={online ? 'error-message' : 'text-warn'} role="alert">
          {t(online ? 'prospect.duplicate_online' : 'prospect.duplicate_offline', {
            name: check.duplicateOf.display_name,
          })}
        </p>
      ) : null}
      {draft.displayName || draft.phone
        ? check.issues.map((issue) => (
            <p key={issue} className="error-message">
              {t(`prospect.issue.${issue}`)}
            </p>
          ))
        : null}
      {!holdsAnyRole(roles, ROLE_SETS.customerCreate) ? (
        <p className="text-warn">{t('prospect.role_hint')}</p>
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
        {busy ? t('sales.submitting') : t('prospect.submit')}
      </button>
    </section>
  );
}
