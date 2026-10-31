/**
 * Collecte d'œufs (ECR-PRD-02 ; action « Collecte d'œufs » du responsable de ferme) : lot de pondeuses
 * ou de reproducteurs, jour, emplacement de stockage, collectés, cassés, non conformes, commercialisables
 * par calibre et à couver, avec le bilan contrôlé avant l'envoi. Commande
 * `production.egg_collection.record` (agrégat `EGG_COLLECTION`), utilisable hors ligne ; les œufs
 * commercialisables entrent aussitôt au disponible local.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import {
  ActionBar,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
} from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { eggStorageLocations, isDailyLot, laysEggs } from './daily.js';
import { checkEggs, EMPTY_EGGS, eggCollectionPayload, eggSetup, type EggDraft } from './eggs.js';
import './production.css';

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

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.egg_collection')} />
        <SkeletonRows />
      </section>
    );
  }

  const now = clock.now();
  const today = businessDayOf(now);
  const lots = refs.productionLots
    .filter((lot) => isDailyLot(lot) && laysEggs(lot))
    .sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'fr'));
  const lot = lots.find((candidate) => candidate.id === lotChoice) ?? lots[0];
  const storages = lot ? eggStorageLocations(refs.locations, lot) : [];
  const storage = storages.find((candidate) => candidate.id === storageChoice) ?? storages[0];
  const setup = lot ? eggSetup(refs.products, refs.settings, now) : undefined;
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
    <Field key={key} label={t(`eggs.${key}_label`)}>
      {(control) => (
        <Input
          {...control}
          inputMode="numeric"
          value={draft[key]}
          onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        />
      )}
    </Field>
  );

  // Ce qui reste à répartir suit la saisie dans la barre d'action : le bilan doit tomber juste.
  const remaining = check?.remaining ?? null;
  const balance =
    remaining !== null && draft.collected ? (
      <>
        <span className="action-bar-label">{t('eggs.remaining_label')}</span>
        <strong
          className={`action-bar-value prd-remaining ${remaining === 0 ? 'is-ok' : 'is-warn'}`}
        >
          {remaining}
        </strong>
      </>
    ) : undefined;

  return (
    <section className="sale">
      <PageHeader
        {...(lot
          ? {
              backTo: ROUTES.dailyEntry(lot.id),
              backLabel: t('eggs.back', { code: lot.lot_code }),
            }
          : {})}
        title={t('nav.screens.egg_collection')}
      />
      <div className="prd-narrow">
        {!online ? (
          <Banner tone="warn" role="status">
            {t('eggs.offline_banner')}
          </Banner>
        ) : null}
        {last ? <CommandResult commandId={last} messages="eggs.result" /> : null}
        {lots.length === 0 || !lot || !setup || !check ? (
          <EmptyState icon="leaf" title={t('eggs.no_lot')} />
        ) : (
          <>
            <div className="prd-form">
              <Field label={t('eggs.lot_label')}>
                {(control) => (
                  <Select
                    {...control}
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
                  </Select>
                )}
              </Field>
              <Field
                label={t('eggs.day_label')}
                error={!dayValid ? t('eggs.day_invalid') : undefined}
              >
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    max={today}
                    value={day}
                    onChange={(event) => setDay(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t('eggs.storage_label')}>
                {(control) => (
                  <Select
                    {...control}
                    value={storage?.id ?? ''}
                    onChange={(event) => setStorageChoice(event.target.value)}
                  >
                    {storages.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="prd-pair">{COUNTERS.map(counter)}</div>
            </div>
            <Section title={t('eggs.grades_title')} className="prd-after">
              {!setup.gradesConfigured ? (
                <p className="prd-note is-warn">{t('eggs.grades_not_configured')}</p>
              ) : null}
              {setup.grades.length === 0 ? (
                <p className="prd-note">{t('eggs.no_grade')}</p>
              ) : (
                <div className="prd-grid">
                  {setup.grades.map((product) => (
                    <Field key={product.id} label={product.name}>
                      {(control) => (
                        <Input
                          {...control}
                          inputMode="numeric"
                          value={draft.grades[product.id] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              grades: { ...current.grades, [product.id]: event.target.value },
                            }))
                          }
                        />
                      )}
                    </Field>
                  ))}
                </div>
              )}
            </Section>
            {check.issues.includes('COUNT_INVALID') ? (
              <p className="prd-note is-bad">{t('eggs.count_invalid')}</p>
            ) : null}
            {check.remaining !== null && check.remaining !== 0 && draft.collected ? (
              <p className="prd-note is-warn" role="status">
                {t('eggs.remaining', { count: check.remaining })}
              </p>
            ) : null}
            {check.issues.includes('HATCHING_PRODUCT_MISSING') ? (
              <p className="prd-note is-bad">{t('eggs.hatching_missing')}</p>
            ) : null}
            {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
            <ActionBar summary={balance}>
              <Button
                size="lg"
                className="submit-sale"
                disabled={!ready}
                loading={busy}
                onClick={() => void submit()}
              >
                {busy ? t('sales.submitting') : t('eggs.submit')}
              </Button>
            </ActionBar>
          </>
        )}
      </div>
    </section>
  );
}
