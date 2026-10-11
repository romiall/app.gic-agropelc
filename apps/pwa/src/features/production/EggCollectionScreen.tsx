/**
 * Collecte d'œufs (ECR-PRD-02 ; action « Collecte d'œufs » du responsable de ferme) : lot de pondeuses
 * ou de reproducteurs, jour, emplacement de stockage, collectés, cassés, non conformes, commercialisables
 * par calibre et à couver, avec le bilan contrôlé avant l'envoi. Commande
 * `production.egg_collection.record` (agrégat `EGG_COLLECTION`), utilisable hors ligne ; les œufs
 * commercialisables entrent aussitôt au disponible local.
 */
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { farmLocations, isDailyLot, laysEggs } from './daily.js';
import { checkEggs, EMPTY_EGGS, eggCollectionPayload, eggSetup, type EggDraft } from './eggs.js';

const COUNTERS = ['collected', 'broken', 'nonconforming', 'hatching'] as const;

export function EggCollectionScreen() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [lotChoice, setLotChoice] = useState<string | null>(searchParams.get('lot'));
  const [day, setDay] = useState(() => businessDayOf(clock.now()));
  const [storageChoice, setStorageChoice] = useState<string | null>(null);
  const [draft, setDraft] = useState<EggDraft>(EMPTY_EGGS);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const ids = { lot: useId(), day: useId(), storage: useId() };

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.egg_collection')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const now = clock.now();
  const today = businessDayOf(now);
  const lots = refs.productionLots
    .filter((lot) => isDailyLot(lot) && laysEggs(lot))
    .sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'fr'));
  const lot = lots.find((candidate) => candidate.id === lotChoice) ?? lots[0];
  const storages = lot ? farmLocations(refs.locations, lot) : [];
  const storage = storages.find((candidate) => candidate.id === storageChoice) ?? storages[0];
  const setup = lot ? eggSetup(refs.products, refs.settings, lot.site_id, now) : undefined;
  const check = setup ? checkEggs(draft, setup) : undefined;
  const dayValid = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today;
  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last);
  const ready =
    lot !== undefined &&
    storage !== undefined &&
    dayValid &&
    check !== undefined &&
    check.values !== null &&
    check.issues.length === 0 &&
    !busy &&
    !settling;

  const submit = async () => {
    if (!ready || !lot || !storage || !check?.values) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'production.egg_collection.record',
        aggregateType: 'EGG_COLLECTION',
        payload: eggCollectionPayload({
          lotId: lot.id,
          collectionDate: day,
          storageLocationId: storage.id,
          values: check.values,
        }),
      });
      setLast(command.command_id);
      setDraft(EMPTY_EGGS);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  const counter = (key: (typeof COUNTERS)[number]) => (
    <div className="field" key={key}>
      <label htmlFor={`eggs-${key}`}>{t(`eggs.${key}_label`)}</label>
      <input
        id={`eggs-${key}`}
        className="text-input"
        inputMode="numeric"
        value={draft[key]}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
      />
    </div>
  );

  return (
    <section className="sale">
      {lot ? (
        <Link to={ROUTES.dailyEntry(lot.id)} className="back-link">
          {t('eggs.back', { code: lot.lot_code })}
        </Link>
      ) : null}
      <h1>{t('nav.screens.egg_collection')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('eggs.offline_banner')}
        </p>
      ) : null}
      {last ? <CommandResult commandId={last} messages="eggs.result" /> : null}
      {lots.length === 0 || !lot || !setup || !check ? (
        <p className="home-muted">{t('eggs.no_lot')}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={ids.lot}>{t('eggs.lot_label')}</label>
            <select
              id={ids.lot}
              className="text-input"
              value={lot.id}
              onChange={(event) => {
                setLotChoice(event.target.value);
                setStorageChoice(null);
              }}
            >
              {lots.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.lot_code}
                </option>
              ))}
            </select>
          </div>
          <div className="line-fields">
            <div className="field">
              <label htmlFor={ids.day}>{t('eggs.day_label')}</label>
              <input
                id={ids.day}
                type="date"
                className="text-input"
                max={today}
                value={day}
                onChange={(event) => setDay(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.storage}>{t('eggs.storage_label')}</label>
              <select
                id={ids.storage}
                className="text-input"
                value={storage?.id ?? ''}
                onChange={(event) => setStorageChoice(event.target.value)}
              >
                {storages.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {!dayValid ? <p className="error-message">{t('eggs.day_invalid')}</p> : null}
          <div className="line-fields">{COUNTERS.map(counter)}</div>
          <section className="sale-block" aria-labelledby="eggs-grades-title">
            <h2 id="eggs-grades-title">{t('eggs.grades_title')}</h2>
            {!setup.gradesConfigured ? (
              <p className="text-warn">{t('eggs.grades_not_configured')}</p>
            ) : null}
            {setup.grades.length === 0 ? (
              <p className="home-muted">{t('eggs.no_grade')}</p>
            ) : (
              <div className="line-fields">
                {setup.grades.map((product) => (
                  <div className="field" key={product.id}>
                    <label htmlFor={`grade-${product.id}`}>{product.name}</label>
                    <input
                      id={`grade-${product.id}`}
                      className="text-input"
                      inputMode="numeric"
                      value={draft.grades[product.id] ?? ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          grades: { ...current.grades, [product.id]: event.target.value },
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
          {check.issues.includes('COUNT_INVALID') ? (
            <p className="error-message">{t('eggs.count_invalid')}</p>
          ) : null}
          {check.remaining !== null && check.remaining !== 0 && draft.collected ? (
            <p className="text-warn" role="status">
              {t('eggs.remaining', { count: check.remaining })}
            </p>
          ) : null}
          {check.issues.includes('HATCHING_PRODUCT_MISSING') ? (
            <p className="error-message">{t('eggs.hatching_missing')}</p>
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
            {busy ? t('sales.submitting') : t('eggs.submit')}
          </button>
        </>
      )}
    </section>
  );
}
