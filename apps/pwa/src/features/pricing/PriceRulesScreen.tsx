/**
 * ECR-PRX-02 « Règles tarifaires » (responsable commercial, direction ; en ligne). Règles d'un produit
 * lues sur le serveur (en vigueur, brouillons, historique) ; rédaction d'une règle ou d'une nouvelle
 * version de la dernière version active (jamais de modification, BR-PRX-007), activation et fin de
 * validité par la Direction (AV-062), conflit d'activation annoncé par le moteur partagé (BR-PRX-006).
 * Un produit désactivé ou non vendable reste consultable, et ses règles peuvent être terminées.
 */
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { prospectZoneOptions } from '../crm/prospect.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, unitLabel } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  submitCommand,
  waitingCommands,
  waitingIds,
} from '../sales/submit.js';
import type { ProductData } from '../sales/types.js';
import { SIM_CHANNELS } from './price-sim.js';
import {
  checkRule,
  conflictsOf,
  defaultValidFrom,
  doualaInstant,
  doualaLocal,
  endAllowed,
  formatRuleInstant,
  formFrom,
  groupRules,
  isLatestVersion,
  supersedesPending,
  minimumEnd,
  predecessorOf,
  ruleDimensions,
  supersedeValidFrom,
  type RuleForm,
  type RuleView,
} from './rules.js';
import { describeScope } from './scope.js';

const ACTIVATION_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Règles lues en ligne : `rules` vaut `undefined` pendant la première lecture et `null` si aucune
 * lecture n'a abouti ; la dernière liste reçue reste affichée pendant une relecture ou une coupure,
 * marquée `stale` (périmée) tant qu'elle ne correspond pas à la dernière opération : on n'agit pas
 * sur une liste périmée (une seconde version ou une activation y serait refusée par la base). Une
 * lecture en échec s'annonce et se relit par `retry`.
 */
function useRules(path: string | null, online: boolean, reloadKey: string) {
  const read = useOnlineRead<{ price_rules?: RuleView[] }>(path, readPath, online, reloadKey);
  const rules: readonly RuleView[] | null | undefined = read.data
    ? (read.data.price_rules ?? [])
    : !path || !online || read.failed
      ? null
      : undefined;
  return { rules, stale: read.stale, failed: read.failed, retry: read.retry };
}

const canDraft = (product: ProductData): boolean =>
  product.is_sellable && product.status === 'ACTIVE';

function emptyForm(product: ProductData): RuleForm {
  return {
    code: '',
    unitPriceText: '',
    pricingUnitCode: product.pricing_mode === 'PER_WEIGHT' ? 'KG' : product.base_unit_code,
    siteId: '',
    zoneId: '',
    customerCategoryId: '',
    channelCode: '',
    minQuantityText: '',
    priorityText: '0',
    commercialCampaignId: '',
    validFrom: defaultValidFrom(clock.now()),
    validTo: '',
    notes: '',
  };
}

interface Editing {
  readonly superseded: RuleView | null;
  /** Produit de la saisie : une reprise ne vaut que pour lui. */
  readonly productId: string;
  /** Saisie reprise après un refus du serveur. */
  readonly form?: RuleForm;
}

/** Options d'une liste, la valeur courante comprise même absente ou inactive (signalée). */
function withCurrent(
  options: readonly { readonly value: string; readonly label: string }[],
  current: string,
  label: string,
): { readonly value: string; readonly label: string }[] {
  if (!current || options.some((option) => option.value === current)) return [...options];
  return [{ value: current, label }, ...options];
}

interface EditorProps {
  readonly refs: SalesReferences;
  readonly product: ProductData;
  readonly rules: readonly RuleView[];
  readonly editing: Editing;
  /** Codes de toutes les règles (nouvelle lignée) ; `undefined` en lecture, `null` si indisponible. */
  readonly takenCodes: ReadonlySet<string> | null | undefined;
  /** Relit les codes après un échec. */
  readonly onRetryCodes: () => void;
  readonly onCancel: () => void;
  readonly onSubmit: (input: Parameters<typeof submitCommand>[0], form: RuleForm) => void;
  readonly userId: string;
  readonly blocked: boolean;
}

function RuleEditor({
  refs,
  product,
  rules,
  editing,
  takenCodes,
  onRetryCodes,
  onCancel,
  onSubmit,
  userId,
  blocked,
}: EditorProps) {
  const { t } = useTranslation();
  const { superseded } = editing;
  const [form, setForm] = useState<RuleForm>(
    () =>
      editing.form ??
      (superseded
        ? formFrom(superseded, supersedeValidFrom(superseded, clock.now()))
        : emptyForm(product)),
  );
  const ids = {
    code: useId(),
    price: useId(),
    site: useId(),
    zone: useId(),
    category: useId(),
    channel: useId(),
    min: useId(),
    priority: useId(),
    from: useId(),
    to: useId(),
    notes: useId(),
  };
  const newLineage = superseded === null;
  // La règle remplacée est relue dans la dernière liste : elle doit être encore active, la dernière
  // de sa lignée, et du produit affiché.
  const fresh = superseded ? rules.find((rule) => rule.id === superseded.id) : undefined;
  const supersededStale =
    superseded !== null &&
    (!fresh ||
      fresh.status !== 'ACTIVE' ||
      !isLatestVersion(fresh, rules) ||
      fresh.productId !== product.id);
  const check = checkRule(form, {
    needsCode: newLineage,
    takenCodes: takenCodes ?? new Set(rules.map((rule) => rule.code)),
    superseded: fresh ?? superseded,
    sites: refs.sites,
    zones: refs.zones,
    now: clock.now(),
  });
  const issueIds = {
    code: `${ids.code}-issue`,
    codes: `${ids.code}-codes`,
    price: `${ids.price}-issue`,
    min: `${ids.min}-issue`,
    priority: `${ids.priority}-issue`,
    dates: `${ids.from}-issue`,
    scope: `${ids.site}-issue`,
  };
  const has = (...codes: string[]) => codes.some((code) => check.issues.includes(code as never));
  const issueField: Readonly<Record<string, string>> = {
    CODE_REQUIRED: issueIds.code,
    CODE_TAKEN: issueIds.code,
    PRICE_INVALID: issueIds.price,
    MIN_QUANTITY_INVALID: issueIds.min,
    PRIORITY_INVALID: issueIds.priority,
    VALID_FROM_INVALID: issueIds.dates,
    VALID_FROM_PAST: issueIds.dates,
    OUTSIDE_SUPERSEDED: issueIds.dates,
    VALID_TO_INVALID: issueIds.dates,
    SITE_NOT_IN_ZONE: issueIds.scope,
  };
  const update = (patch: Partial<RuleForm>) => setForm((current) => ({ ...current, ...patch }));
  const candidate: RuleView | null =
    check.issues.length === 0
      ? {
          id: 'candidate',
          code: form.code,
          version: 0,
          productId: product.id,
          unitPriceXaf: check.unitPriceXaf as number,
          pricingUnitCode: form.pricingUnitCode,
          zoneId: form.zoneId || null,
          siteId: form.siteId || null,
          customerCategoryId: form.customerCategoryId || null,
          channelCode: form.channelCode || null,
          minQuantity: check.minQuantity,
          commercialCampaignId: form.commercialCampaignId || null,
          priority: check.priority,
          specificity: 0,
          validFrom: check.validFrom as string,
          validTo: check.validTo,
          status: 'DRAFT',
        }
      : null;
  const conflicts = candidate
    ? conflictsOf(candidate, rules, refs.zones, superseded?.id ?? null)
    : [];
  // Une nouvelle lignée attend la liste de tous les codes : un code en double ne serait pas refusé
  // proprement par le serveur (S-29).
  const codesReady = !newLineage || (takenCodes !== undefined && takenCodes !== null);
  const ready = check.issues.length === 0 && codesReady && !supersededStale && !blocked;

  const submit = () => {
    if (!ready) return;
    const dimensions = ruleDimensions(product.id, form, check);
    onSubmit(
      superseded
        ? {
            authorUserId: userId,
            commandType: 'pricing.rule.supersede',
            aggregateType: 'PRICE_RULE',
            payload: { ...dimensions, supersedesRuleId: (fresh ?? superseded).id },
          }
        : {
            authorUserId: userId,
            commandType: 'pricing.rule.draft',
            aggregateType: 'PRICE_RULE',
            payload: { ...dimensions, code: form.code.trim() },
          },
      form,
    );
  };

  const select = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: readonly { readonly value: string; readonly label: string }[],
    invalidBy?: string,
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="text-input"
        value={value}
        aria-invalid={invalidBy ? true : undefined}
        aria-describedby={invalidBy}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t('price_rules.any')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="sale-block" aria-labelledby="price-rule-editor-title">
      <h2 id="price-rule-editor-title">
        {superseded
          ? t('price_rules.supersede_title', { code: superseded.code, version: superseded.version })
          : t('price_rules.draft_title')}
      </h2>
      {newLineage ? (
        <div className="field">
          <label htmlFor={ids.code}>{t('price_rules.code_label')}</label>
          <input
            id={ids.code}
            className="text-input"
            maxLength={40}
            value={form.code}
            aria-invalid={has('CODE_REQUIRED', 'CODE_TAKEN') || undefined}
            aria-describedby={
              [
                has('CODE_REQUIRED', 'CODE_TAKEN') ? issueIds.code : null,
                takenCodes === null ? issueIds.codes : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(event) => update({ code: event.target.value })}
          />
          {takenCodes === undefined ? (
            <p className="home-muted">{t('price_rules.codes_loading')}</p>
          ) : takenCodes === null ? (
            <div id={issueIds.codes} className="error-message">
              <p>{t('price_rules.codes_unavailable')}</p>
              <button type="button" className="secondary" onClick={onRetryCodes}>
                {t('ledger.retry')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {form.commercialCampaignId ? (
        <p className="home-muted">{t('price_rules.campaign_kept')}</p>
      ) : null}
      {supersededStale ? (
        <p className="error-message" role="alert">
          {t('price_rules.superseded_changed')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={ids.price}>
          {t('price_rules.price_label', { unit: unitLabel(form.pricingUnitCode) })}
        </label>
        <input
          id={ids.price}
          className="text-input"
          inputMode="numeric"
          value={form.unitPriceText}
          aria-invalid={has('PRICE_INVALID') || undefined}
          aria-describedby={has('PRICE_INVALID') ? issueIds.price : undefined}
          onChange={(event) => update({ unitPriceText: event.target.value })}
        />
      </div>
      {select(
        ids.site,
        t('price_sim.site_label'),
        form.siteId,
        (siteId) => update({ siteId }),
        withCurrent(
          [...refs.sites.values()]
            .filter((site) => site.status === 'ACTIVE')
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
            .map((site) => ({ value: site.id, label: site.name })),
          form.siteId,
          refs.sites.get(form.siteId)
            ? t('price_rules.inactive_option', { name: refs.sites.get(form.siteId)?.name ?? '' })
            : t('price_rules.unknown_option', { name: form.siteId }),
        ),
        has('SITE_NOT_IN_ZONE') ? issueIds.scope : undefined,
      )}
      {select(
        ids.zone,
        t('price_sim.zone_label'),
        form.zoneId,
        (zoneId) => update({ zoneId }),
        withCurrent(
          prospectZoneOptions(refs.zones).map((zone) => ({ value: zone.id, label: zone.label })),
          form.zoneId,
          refs.zones.get(form.zoneId)
            ? t('price_rules.inactive_option', { name: refs.zones.get(form.zoneId)?.name ?? '' })
            : t('price_rules.unknown_option', { name: form.zoneId }),
        ),
        has('SITE_NOT_IN_ZONE') ? issueIds.scope : undefined,
      )}
      {select(
        ids.category,
        t('price_sim.category_label'),
        form.customerCategoryId,
        (customerCategoryId) => update({ customerCategoryId }),
        withCurrent(
          refs.customerCategories.map((category) => ({ value: category.id, label: category.name })),
          form.customerCategoryId,
          refs.customerCategoryById.get(form.customerCategoryId)
            ? t('price_rules.inactive_option', {
                name: refs.customerCategoryById.get(form.customerCategoryId)?.name ?? '',
              })
            : t('price_rules.unknown_option', { name: form.customerCategoryId }),
        ),
      )}
      {select(
        ids.channel,
        t('price_sim.channel_label'),
        form.channelCode,
        (channelCode) => update({ channelCode }),
        withCurrent(
          SIM_CHANNELS.map((code) => ({ value: code, label: t(`price_sim.channel.${code}`) })),
          form.channelCode,
          t('price_rules.unknown_option', { name: form.channelCode }),
        ),
      )}
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.min}>
            {t('price_rules.min_quantity_label', { unit: unitLabel(form.pricingUnitCode) })}
          </label>
          <input
            id={ids.min}
            className="text-input"
            inputMode="decimal"
            value={form.minQuantityText}
            aria-invalid={has('MIN_QUANTITY_INVALID') || undefined}
            aria-describedby={has('MIN_QUANTITY_INVALID') ? issueIds.min : undefined}
            onChange={(event) => update({ minQuantityText: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.priority}>{t('price_rules.priority_label')}</label>
          <input
            id={ids.priority}
            className="text-input"
            inputMode="numeric"
            value={form.priorityText}
            aria-invalid={has('PRIORITY_INVALID') || undefined}
            aria-describedby={has('PRIORITY_INVALID') ? issueIds.priority : undefined}
            onChange={(event) => update({ priorityText: event.target.value })}
          />
        </div>
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.from}>{t('price_rules.valid_from_label')}</label>
          <input
            id={ids.from}
            type="datetime-local"
            className="text-input"
            value={form.validFrom}
            aria-invalid={
              has('VALID_FROM_INVALID', 'VALID_FROM_PAST', 'OUTSIDE_SUPERSEDED') || undefined
            }
            aria-describedby={
              has('VALID_FROM_INVALID', 'VALID_FROM_PAST', 'OUTSIDE_SUPERSEDED')
                ? issueIds.dates
                : undefined
            }
            onChange={(event) => update({ validFrom: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.to}>{t('price_rules.valid_to_label')}</label>
          <input
            id={ids.to}
            type="datetime-local"
            className="text-input"
            value={form.validTo}
            aria-invalid={has('VALID_TO_INVALID') || undefined}
            aria-describedby={has('VALID_TO_INVALID') ? issueIds.dates : undefined}
            onChange={(event) => update({ validTo: event.target.value })}
          />
        </div>
      </div>
      <p className="home-muted">{t('price_rules.activation_hint')}</p>
      <div className="field">
        <label htmlFor={ids.notes}>{t('price_rules.notes_label')}</label>
        <input
          id={ids.notes}
          className="text-input"
          maxLength={2000}
          value={form.notes}
          onChange={(event) => update({ notes: event.target.value })}
        />
      </div>
      <div role="status" aria-live="polite">
        {[...new Set(check.issues.map((issue) => issueField[issue] ?? issue))].map((fieldId) => (
          <p key={fieldId} id={fieldId} className="error-message">
            {check.issues
              .filter((issue) => (issueField[issue] ?? issue) === fieldId)
              .map((issue) => t(`price_rules.issue.${issue}`))
              .join(' ')}
          </p>
        ))}
      </div>
      {conflicts.length > 0 ? (
        <p className="text-warn" role="status">
          {t('price_rules.conflict_warning', { count: conflicts.length })}
        </p>
      ) : null}
      <div className="result-actions">
        <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
          {superseded ? t('price_rules.submit_supersede') : t('price_rules.submit_draft')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </section>
  );
}

export function PriceRulesScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const [productId, setProductId] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [ending, setEnding] = useState<{
    ruleId: string;
    value: string;
    confirmed?: boolean;
  } | null>(null);
  const [last, setLast] = useState<{ commandId: string; editing?: Editing }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const productSelectId = useId();
  const endId = useId();
  const lastCommand = refs?.outbox.find((command) => command.command_id === last?.commandId);
  // Opérations tarifaires de l'utilisateur encore sans réponse, même d'une visite précédente : elles
  // bloquent la suivante, et leur réponse déclenche la relecture comme celle de la dernière.
  const pendingPricing = waitingCommands(refs?.outbox ?? [], 'pricing.rule.', userId);
  // Clé de relecture sur la phase (le statut brut passe par SYNCING à chaque cycle), et sur toutes
  // les opérations encore en attente, échec répété compris (leur réponse tardive relit aussi).
  const reloadKey = `${last?.commandId ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(
    refs?.outbox ?? [],
    'pricing.rule.',
    userId,
  )}`;
  const productRules = useRules(
    productId ? `/api/v1/price-rules?product_id=${encodeURIComponent(productId)}` : null,
    online,
    reloadKey,
  );
  const rules = productRules.rules;
  // Règles dont une nouvelle version attend l'envoi (échec répété compris) : pas de second remplacement.
  const pendingSupersede = supersedesPending(refs?.outbox ?? [], userId);
  // Codes de toutes les lignées, pour une nouvelle règle seulement (unicité du code).
  const allRules = useRules(
    editing && editing.superseded === null ? '/api/v1/price-rules' : null,
    online,
    reloadKey,
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.price_rules')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const now = clock.now();
  // Action réservée : aucun repli permissif tant que les rôles ne sont pas connus.
  const director = navigation?.roles.includes('DIRECTION') === true;
  const products = [...refs.products].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = products.find((candidate) => candidate.id === productId);
  // L'écran est en ligne : on attend la réponse définitive de toute opération tarifaire de
  // l'utilisateur encore en attente (même après un retour sur l'écran) et la relecture qui la suit
  // avant d'en proposer une autre (pas de seconde activation ni de version en double).
  const waiting =
    (last !== undefined &&
      (lastCommand === undefined || isBlockingWait(lastCommand, refs.outbox))) ||
    pendingPricing.length > 0;
  const blocked = busy || waiting || productRules.stale;
  const rejected = lastCommand !== undefined && phaseOf(lastCommand) === 'REJECTED';
  // Retour sur l'écran : la dernière opération encore en attente redevient « la dernière », pour que
  // son résultat (refus compris) reste affiché jusqu'à la réponse.
  const adopt = last ? undefined : lastWaitingCommand(refs.outbox, 'pricing.rule.', userId);
  if (adopt) setLast({ commandId: adopt.command_id });
  const shownCommandId = last?.commandId;
  const grouped = rules ? groupRules(rules, now) : null;
  // Codes pris : toutes les lignées lues, plus les brouillons encore en attente d'envoi.
  const takenCodes = allRules.failed
    ? null
    : allRules.rules === undefined || (allRules.stale && online)
      ? undefined
      : allRules.rules === null
        ? null
        : new Set([
            ...allRules.rules.map((r) => r.code),
            ...refs.outbox
              .filter((command) => command.command_type === 'pricing.rule.draft')
              .filter((command) => phaseOf(command) !== 'REJECTED')
              .map((command) => String((command.payload as { code?: string }).code ?? '')),
          ]);

  const send = async (input: Parameters<typeof submitCommand>[0], resume?: Editing) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, ...(resume ? { editing: resume } : {}) });
      setEditing(null);
      setEnding(null);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  const activate = (rule: RuleView) =>
    void send({
      authorUserId: userId,
      commandType: 'pricing.rule.activate',
      aggregateType: 'PRICE_RULE',
      aggregateId: rule.id,
      payload: {},
    });

  const describe = (rule: RuleView) => describeScope(rule, refs, rule.pricingUnitCode, t);
  const period = (rule: RuleView) =>
    rule.validTo
      ? t('price_rules.period_bounded', {
          from: formatRuleInstant(rule.validFrom),
          to: formatRuleInstant(rule.validTo),
        })
      : t('price_rules.period_open', { from: formatRuleInstant(rule.validFrom) });

  const ruleRow = (rule: RuleView, actions: ReactNode) => (
    <li key={rule.id} className="line-card" aria-label={`${rule.code} v${rule.version}`}>
      <div className="line-head">
        <strong>
          {t('price_rules.price', {
            price: formatMoney(rule.unitPriceXaf),
            unit: unitLabel(rule.pricingUnitCode),
          })}
        </strong>
        <span className="badge badge-info">
          {rule.code} v{rule.version}
        </span>
      </div>
      <p className="home-muted">{describe(rule)}</p>
      <p className="home-muted">{period(rule)}</p>
      {actions}
    </li>
  );

  const endControls = (rule: RuleView) => {
    if (!director || !rules) return null;
    if (ending?.ruleId !== rule.id) {
      return (
        <button
          type="button"
          className="secondary"
          disabled={!online || blocked}
          onClick={() => setEnding({ ruleId: rule.id, value: doualaLocal(minimumEnd(rule, now)) })}
        >
          {t('price_rules.end')}
        </button>
      );
    }
    const allowed = endAllowed(ending.value, rule, now);
    // Une fin avant la date d'effet du brouillon de la version suivante rendrait celui-ci
    // inactivable (la fin de la règle remplacée ne peut que reculer, S-29) : confirmation exigée.
    const successor = rules.find(
      (candidate) =>
        candidate.code === rule.code &&
        candidate.version === rule.version + 1 &&
        candidate.status === 'DRAFT',
    );
    const endInstant = doualaInstant(ending.value);
    const breaksSuccessor =
      successor !== undefined &&
      endInstant !== null &&
      endInstant < new Date(successor.validFrom).toISOString();
    return (
      <div className="field">
        <label htmlFor={endId}>{t('price_rules.end_label')}</label>
        <input
          id={endId}
          type="datetime-local"
          className="text-input"
          min={doualaLocal(minimumEnd(rule, now))}
          value={ending.value}
          aria-invalid={!allowed || undefined}
          aria-describedby={!allowed ? `${endId}-issue` : undefined}
          onChange={(event) => setEnding({ ruleId: rule.id, value: event.target.value })}
        />
        {!allowed ? (
          <p id={`${endId}-issue`} className="error-message">
            {t('price_rules.end_invalid')}
          </p>
        ) : null}
        {breaksSuccessor ? (
          <>
            <p className="text-warn" role="alert">
              {t('price_rules.end_before_successor', { version: successor.version })}
            </p>
            <label className="choice">
              <input
                type="checkbox"
                checked={ending.confirmed === true}
                onChange={(event) => setEnding({ ...ending, confirmed: event.target.checked })}
              />
              {t('price_rules.end_confirm_successor')}
            </label>
          </>
        ) : null}
        <button
          type="button"
          className="secondary"
          disabled={
            !online || blocked || !allowed || (breaksSuccessor && ending.confirmed !== true)
          }
          onClick={() =>
            void send({
              authorUserId: userId,
              commandType: 'pricing.rule.end',
              aggregateType: 'PRICE_RULE',
              aggregateId: rule.id,
              payload: { validTo: doualaInstant(ending.value) as string },
            })
          }
        >
          {t('price_rules.end_confirm')}
        </button>
      </div>
    );
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.price_rules')}</h1>
      {!online ? (
        <p className="alert alert-error" role="alert">
          {t('price_rules.online_only')}
        </p>
      ) : null}
      {shownCommandId ? (
        <CommandResult commandId={shownCommandId} messages="price_rules.result">
          {rejected && last?.editing && last.editing.productId === productId && !editing ? (
            <button type="button" onClick={() => last?.editing && setEditing(last.editing)}>
              {t('price_rules.resume')}
            </button>
          ) : null}
        </CommandResult>
      ) : null}
      <div className="field">
        <label htmlFor={productSelectId}>{t('price_sim.product_label')}</label>
        <select
          id={productSelectId}
          className="text-input"
          value={productId}
          onChange={(event) => {
            setProductId(event.target.value);
            setEditing(null);
            setEnding(null);
          }}
        >
          <option value="">{t('loss.product_placeholder')}</option>
          {products.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {canDraft(candidate)
                ? candidate.name
                : t('price_rules.product_read_only', { name: candidate.name })}
            </option>
          ))}
        </select>
      </div>
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      {product && online && rules === undefined ? (
        <p className="home-muted">{t('price_rules.loading')}</p>
      ) : null}
      {product && online && productRules.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{t('price_rules.unavailable')}</p>
          <button type="button" className="secondary" onClick={productRules.retry}>
            {t('ledger.retry')}
          </button>
        </div>
      ) : null}
      {product && rules && productRules.stale && online && !productRules.failed ? (
        <p className="home-muted" role="status">
          {t('price_rules.refreshing')}
        </p>
      ) : null}
      {product && rules && grouped && editing ? (
        <RuleEditor
          key={last?.commandId ?? 'new'}
          refs={refs}
          product={product}
          rules={rules}
          editing={editing}
          takenCodes={takenCodes}
          onRetryCodes={allRules.retry}
          onCancel={() => setEditing(null)}
          onSubmit={(input, form) =>
            void send(input, { superseded: editing.superseded, productId: product.id, form })
          }
          userId={userId}
          blocked={blocked || !online}
        />
      ) : null}
      {product && rules && grouped && !editing ? (
        <>
          {canDraft(product) ? (
            <button
              type="button"
              className="btn-block"
              disabled={!online || blocked}
              onClick={() => setEditing({ superseded: null, productId: product.id })}
            >
              {t('price_rules.new_rule')}
            </button>
          ) : (
            <p className="home-muted">{t('price_rules.read_only_hint')}</p>
          )}
          <section className="sale-block" aria-labelledby="price-rules-active-title">
            <h2 id="price-rules-active-title">{t('price_rules.active_title')}</h2>
            {grouped.active.length === 0 ? (
              <p className="home-muted">{t('price_rules.none')}</p>
            ) : (
              <ul className="line-list">
                {grouped.active.map((rule) =>
                  ruleRow(
                    rule,
                    <div className="result-actions">
                      {canDraft(product) && !isLatestVersion(rule, rules) ? (
                        // Version plus récente relue : un remplacement de l'appareil encore en
                        // attente ne pourra pas être enregistré.
                        <p className="home-muted">
                          {t('price_rules.newer_version_exists')}
                          {pendingSupersede.get(rule.id)?.mine
                            ? ` ${t('price_rules.supersede_blocked')}`
                            : ''}
                        </p>
                      ) : canDraft(product) && pendingSupersede.has(rule.id) ? (
                        <p className="home-muted">
                          {pendingSupersede.get(rule.id)?.mine
                            ? pendingSupersede.get(rule.id)?.repeated
                              ? t('price_rules.supersede_retrying')
                              : t('price_rules.supersede_pending')
                            : t('price_rules.supersede_pending_other')}
                        </p>
                      ) : canDraft(product) ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={!online || blocked}
                          onClick={() => setEditing({ superseded: rule, productId: product.id })}
                        >
                          {t('price_rules.supersede')}
                        </button>
                      ) : null}
                      {endControls(rule)}
                    </div>,
                  ),
                )}
              </ul>
            )}
          </section>
          <section className="sale-block" aria-labelledby="price-rules-drafts-title">
            <h2 id="price-rules-drafts-title">{t('price_rules.drafts_title')}</h2>
            {grouped.drafts.length === 0 ? (
              <p className="home-muted">{t('price_rules.none')}</p>
            ) : (
              <ul className="line-list">
                {grouped.drafts.map((rule) => {
                  const predecessor = predecessorOf(rule, rules);
                  const conflicts = conflictsOf(rule, rules, refs.zones, predecessor?.id ?? null);
                  const retroactive =
                    new Date(rule.validFrom).getTime() < now.getTime() - ACTIVATION_TOLERANCE_MS;
                  // L'activation fixe la fin de la règle remplacée à la date d'effet du brouillon :
                  // elle doit tomber après son début et au plus tard à sa fin actuelle.
                  const outside =
                    predecessor !== null &&
                    (new Date(rule.validFrom) <= new Date(predecessor.validFrom) ||
                      (predecessor.validTo !== null &&
                        new Date(rule.validFrom) > new Date(predecessor.validTo)));
                  return ruleRow(
                    rule,
                    <>
                      {conflicts.length > 0 ? (
                        <p className="text-warn">
                          {t('price_rules.conflict_warning', { count: conflicts.length })}
                        </p>
                      ) : null}
                      {retroactive ? (
                        <p className="text-warn">{t('price_rules.retroactive')}</p>
                      ) : null}
                      {outside ? (
                        <p className="text-warn">{t('price_rules.outside_superseded')}</p>
                      ) : null}
                      {director ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            !online || blocked || conflicts.length > 0 || retroactive || outside
                          }
                          onClick={() => activate(rule)}
                        >
                          {t('price_rules.activate')}
                        </button>
                      ) : (
                        <p className="home-muted">{t('price_rules.activation_by_direction')}</p>
                      )}
                    </>,
                  );
                })}
              </ul>
            )}
          </section>
          {grouped.history.length > 0 ? (
            <section className="sale-block" aria-labelledby="price-rules-history-title">
              <h2 id="price-rules-history-title">{t('price_rules.history_title')}</h2>
              <ul className="line-list">{grouped.history.map((rule) => ruleRow(rule, null))}</ul>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
