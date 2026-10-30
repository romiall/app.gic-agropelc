/**
 * ECR-STK-06 « Quotas » (magasinier, responsable de ferme, responsable commercial, Direction :
 * `inventory.allocation.manage`). En ligne seulement : sur un emplacement partagé, accorder un quota à
 * un couple (utilisateur, appareil) déjà connu (AV-238, S-28), l'augmenter (version attendue,
 * ADR-033 §9) ou le révoquer avec un motif (BR-STK-014). La libération est faite par le détenteur, sur
 * l'accueil du PDV (AV-237). Le serveur contrôle le disponible (`ALLOCATION_EXCEEDS_AVAILABLE`).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionBar, Button, PageHeader } from '../../components/ui/index.js';
import { isAllocationExpired } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS } from '../../app/screens.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, formatQuantityUnit, unitLabel } from '../sales/format.js';
import { readPath, useOnlineRead, type ReadResult } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { stockKey } from '../sales/stock.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
  waitingIds,
} from '../sales/submit.js';
import {
  activeQuotas,
  grantPayload,
  heldProducts,
  holderKey,
  knownHolders,
  MAX_REVOKE_REASON,
  parsePositiveQuantity,
  parseValidityHours,
  shortId,
  unallocated,
  type AllocationItem,
  type AllocationsPage,
} from './allocations.js';
import { stockLocations } from './stock-view.js';

const MANAGED_COMMANDS = new Set([
  'inventory.allocation.grant',
  'inventory.allocation.increase',
  'inventory.allocation.revoke',
]);

type Kind = 'grant' | 'increase' | 'revoke';

/** Taille d'une page de `GET /allocations` (`INVENTORY_LIST_MAX_LIMIT`). */
const PAGE_LIMIT = 200;
/** Pages lues au plus : quotas actifs (liste annoncée partielle au-delà), historique des détenteurs. */
const ACTIVE_PAGES = 5;
const HISTORY_PAGES = 2;

interface QuotasRead {
  /** Quotas actifs de l'emplacement, toutes pages lues (`status=ACTIVE`). */
  readonly active: readonly AllocationItem[];
  /** Quotas actifs au-delà des pages lues. */
  readonly activeMore: boolean;
  /** Restes actifs par produit (complets, servis avec chaque page). */
  readonly totals: AllocationsPage['active_totals'];
  /** Quotas les plus récents de tous statuts, pour les détenteurs connus (AV-238). */
  readonly history: readonly AllocationItem[];
  readonly historyMore: boolean;
}

/** Lit au plus `maxPages` pages d'une liste de quotas en suivant `next_cursor`. */
async function readList(
  path: string,
  maxPages: number,
): Promise<ReadResult<{ readonly pages: readonly AllocationsPage[]; readonly more: boolean }>> {
  const pages: AllocationsPage[] = [];
  let cursor: string | null = null;
  do {
    const result: ReadResult<AllocationsPage> = await readPath<AllocationsPage>(
      cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path,
    );
    if (!result.ok) return result;
    pages.push(result.data);
    cursor = result.data.next_cursor || null;
  } while (cursor !== null && pages.length < maxPages);
  return { ok: true, data: { pages, more: cursor !== null } };
}

/**
 * Quotas d'un emplacement : les actifs à part, toutes pages lues (un quota échu reste actif tant que
 * son détenteur ne l'a pas libéré : il ne doit pas sortir de la liste derrière les plus récents), et
 * l'historique récent pour les détenteurs connus.
 */
async function readQuotas(locationId: string): Promise<ReadResult<QuotasRead>> {
  const base = `/api/v1/allocations?location_id=${locationId}&limit=${PAGE_LIMIT}`;
  const active = await readList(`${base}&status=ACTIVE`, ACTIVE_PAGES);
  if (!active.ok) return active;
  const history = await readList(base, HISTORY_PAGES);
  if (!history.ok) return history;
  return {
    ok: true,
    data: {
      active: active.data.pages.flatMap((page) => page.allocations),
      activeMore: active.data.more,
      totals: active.data.pages[0]?.active_totals,
      history: history.data.pages.flatMap((page) => page.allocations),
      historyMore: history.data.more,
    },
  };
}

const KINDS: Readonly<Record<string, Kind>> = {
  'inventory.allocation.grant': 'grant',
  'inventory.allocation.increase': 'increase',
  'inventory.allocation.revoke': 'revoke',
};

export function AllocationsScreen() {
  const { t } = useTranslation();
  const { state, deviceId } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const navigation = useRememberedNavigation(userId);
  const online = useOnline();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [holderChoice, setHolderChoice] = useState('');
  const [productChoice, setProductChoice] = useState('');
  const [quantityText, setQuantityText] = useState('');
  const [hoursText, setHoursText] = useState('');
  const [editing, setEditing] = useState<{ id: string; kind: 'increase' | 'revoke' } | null>(null);
  const [editText, setEditText] = useState('');
  const [last, setLast] = useState<{ commandId: string; kind: Kind }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ids = {
    location: useId(),
    holder: useId(),
    product: useId(),
    quantity: useId(),
    hours: useId(),
    hoursHelp: useId(),
    edit: useId(),
  };

  // Emplacements où un quota s'accorde : partagés et actifs (sinon `ALLOCATION_LOCATION_INVALID` ou
  // `ALLOCATION_LOCATION_NOT_SHARED`).
  const locations = refs
    ? stockLocations(refs).filter(
        (location) => location.status === 'ACTIVE' && location.custody_mode === 'SHARED',
      )
    : [];
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  // Opérations de gestion de l'utilisateur seulement (la libération, du détenteur, n'en est pas).
  const managed = (refs?.outbox ?? []).filter((command) =>
    MANAGED_COMMANDS.has(command.command_type),
  );
  const lastCommand = refs?.outbox.find((command) => command.command_id === last?.commandId);
  // Relue à chaque réponse, y compris celle d'une opération saisie avant de quitter l'écran.
  const reloadKey = `${last?.commandId ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(
    managed,
    'inventory.allocation.',
    userId,
  )}`;
  const read = useOnlineRead<QuotasRead>(
    online && location ? location.id : null,
    readQuotas,
    online,
    reloadKey,
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.allocations')} />
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale">
        <PageHeader title={t('nav.screens.allocations')} />
        <p className="home-muted">{t('quotas.online_only')}</p>
      </section>
    );
  }
  if (!location) {
    return (
      <section className="sale">
        <PageHeader title={t('nav.screens.allocations')} />
        <p className="home-muted">{t('quotas.no_location')}</p>
      </section>
    );
  }

  // Retour sur l'écran avec une opération en attente : son résultat est annoncé.
  const adopt = last ? undefined : lastWaitingCommand(managed, 'inventory.allocation.', userId);
  if (adopt) setLast({ commandId: adopt.command_id, kind: KINDS[adopt.command_type] ?? 'grant' });

  const now = clock.now();
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const page = read.data;
  const active = activeQuotas(page?.active ?? []);
  // Vous-même : seulement si votre rôle peut libérer le quota (AV-238, `inventory.allocation.release`).
  const self =
    deviceId && holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.allocationRelease)
      ? { userId, deviceId }
      : null;
  const holders = knownHolders([...active, ...(page?.history ?? [])], self);
  const holder = holders.find((candidate) => holderKey(candidate) === holderChoice);
  const held = heldProducts(active, holder);
  const stocked = [...refs.stock.values()]
    .filter((balance) => balance.location_id === location.id)
    .map((balance) => products.get(balance.product_id))
    .filter((product): product is NonNullable<typeof product> => product !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = stocked.find(
    (candidate) => candidate.id === productChoice && !held.has(candidate.id),
  );
  const room = product
    ? unallocated(
        Number(refs.stock.get(stockKey(location.id, product.id))?.qty_on_hand ?? 0),
        page?.totals ? { active_totals: page.totals } : {},
        product.id,
      )
    : null;
  const quantity = parsePositiveQuantity(quantityText);
  const hours = hoursText.trim() === '' ? null : parseValidityHours(hoursText);
  const hoursInvalid = hoursText.trim() !== '' && hours === null;
  const waiting = refs.outbox.some(
    (command) =>
      MANAGED_COMMANDS.has(command.command_type) &&
      command.author_user_id === userId &&
      isBlockingWait(command, refs.outbox),
  );
  const blocked = busy || waiting || read.stale || !page;

  const send = async (kind: Kind, input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, kind });
      setEditing(null);
      setEditText('');
      if (kind === 'grant') {
        setQuantityText('');
        setHoursText('');
      }
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const grant = () => {
    if (!holder || !product || quantity === null || hoursInvalid) return;
    void send('grant', {
      authorUserId: userId,
      commandType: 'inventory.allocation.grant',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: idGenerator.newId(),
      payload: grantPayload({
        holder,
        locationId: location.id,
        productId: product.id,
        quantityBase: quantity,
        validityHours: hours,
      }),
    });
  };

  const holderLabel = (item: Pick<AllocationItem, 'holderUserId' | 'holderDeviceId'>): string =>
    t('quotas.holder', {
      user: item.holderUserId === userId ? t('quotas.you') : shortId(item.holderUserId ?? ''),
      device:
        item.holderDeviceId === deviceId
          ? t('quotas.this_device')
          : shortId(item.holderDeviceId ?? ''),
    });

  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.allocations')} />
      {locations.length > 1 ? (
        <div className="field">
          <label htmlFor={ids.location}>{t('quotas.location_label')}</label>
          <select
            id={ids.location}
            className="text-input"
            value={location.id}
            onChange={(event) => {
              setLocationChoice(event.target.value);
              setProductChoice('');
              setEditing(null);
            }}
          >
            {locations.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="picked-title">{location.name}</p>
      )}
      {last ? (
        <CommandResult commandId={last.commandId} messages={`quotas.${last.kind}_result`} />
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      {read.denied ? (
        <p className="alert alert-error" role="alert">
          {t('quotas.denied')}
        </p>
      ) : read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{t('quotas.failed')}</p>
          <button type="button" className="secondary" onClick={read.retry}>
            {t('distribution.retry')}
          </button>
        </div>
      ) : !page ? (
        <p className="home-muted" aria-busy="true">
          {t('sales.loading')}
        </p>
      ) : (
        <>
          <section className="sale-block" aria-labelledby="quotas-active-title">
            <h2 id="quotas-active-title">{t('quotas.active_title')}</h2>
            {page.activeMore ? (
              <p className="text-warn" role="status">
                {t('quotas.active_partial', { count: active.length })}
              </p>
            ) : null}
            {active.length === 0 ? (
              <p className="home-muted">{t('quotas.active_empty')}</p>
            ) : (
              <ul className="line-list">
                {active.map((item) => {
                  const name = products.get(item.productId)?.name ?? '';
                  const unit = products.get(item.productId)?.base_unit_code ?? '';
                  const open = editing?.id === item.id ? editing.kind : null;
                  const increase = open === 'increase' ? parsePositiveQuantity(editText) : null;
                  const who = holderLabel(item);
                  // Échu mais encore actif (le serveur ne libère jamais seul) : il ne se consomme
                  // plus ; l'augmenter gèlerait du stock (SM-ALLOCATION).
                  const expired = isAllocationExpired(
                    item.validUntil ? new Date(item.validUntil) : null,
                    now,
                  );
                  return (
                    <li
                      key={item.id}
                      className="line-card"
                      aria-label={t('quotas.row_label', { name, holder: who })}
                    >
                      <p>
                        <strong>{name}</strong> · {who}
                      </p>
                      <p className="home-muted">
                        {t(item.validUntil ? 'quotas.remaining_until' : 'quotas.remaining', {
                          remaining: formatQuantityUnit(item.quantityRemaining, unit, refs.units),
                          granted: formatQuantityUnit(item.quantityGranted, unit, refs.units),
                          until: item.validUntil ? formatDateTime(item.validUntil) : '',
                        })}
                      </p>
                      {item.revocationPending ? (
                        <p className="text-warn">{t('quotas.revocation_pending')}</p>
                      ) : expired ? (
                        <p className="text-warn">{t('quotas.expired')}</p>
                      ) : null}
                      {open === null ? (
                        <div className="result-actions">
                          {!item.revocationPending && !expired ? (
                            <button
                              type="button"
                              className="secondary"
                              disabled={blocked}
                              onClick={() => {
                                setEditing({ id: item.id, kind: 'increase' });
                                setEditText('');
                              }}
                            >
                              {t('quotas.increase_open', { name, holder: who })}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="secondary"
                            disabled={blocked}
                            onClick={() => {
                              setEditing({ id: item.id, kind: 'revoke' });
                              setEditText('');
                            }}
                          >
                            {t('quotas.revoke_open', { name, holder: who })}
                          </button>
                        </div>
                      ) : (
                        <div className="field">
                          <label htmlFor={ids.edit}>
                            {t(
                              open === 'increase' ? 'quotas.increase_label' : 'quotas.reason_label',
                              {
                                unit: unitLabel(unit, 1, refs.units),
                              },
                            )}
                          </label>
                          {open === 'increase' ? (
                            <input
                              id={ids.edit}
                              className="text-input"
                              inputMode="decimal"
                              value={editText}
                              onChange={(event) => setEditText(event.target.value)}
                            />
                          ) : (
                            <textarea
                              id={ids.edit}
                              className="text-input"
                              rows={2}
                              maxLength={MAX_REVOKE_REASON}
                              value={editText}
                              onChange={(event) => setEditText(event.target.value)}
                            />
                          )}
                          <div className="result-actions">
                            <button
                              type="button"
                              disabled={
                                blocked ||
                                (open === 'increase' ? increase === null : editText.trim() === '')
                              }
                              onClick={() =>
                                open === 'increase'
                                  ? void send('increase', {
                                      authorUserId: userId,
                                      commandType: 'inventory.allocation.increase',
                                      aggregateType: 'STOCK_ALLOCATION',
                                      aggregateId: item.id,
                                      baseVersion: item.version,
                                      payload: { quantityBase: increase ?? 0 },
                                    })
                                  : void send('revoke', {
                                      authorUserId: userId,
                                      commandType: 'inventory.allocation.revoke',
                                      aggregateType: 'STOCK_ALLOCATION',
                                      aggregateId: item.id,
                                      payload: { reason: editText.trim() },
                                    })
                              }
                            >
                              {t(
                                open === 'increase'
                                  ? 'quotas.increase_submit'
                                  : 'quotas.revoke_submit',
                              )}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setEditing(null)}
                            >
                              {t('quotas.cancel_edit')}
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="sale-block" aria-labelledby="quotas-grant-title">
            <h2 id="quotas-grant-title">{t('quotas.grant_title')}</h2>
            <div className="field">
              <label htmlFor={ids.holder}>{t('quotas.holder_label')}</label>
              <select
                id={ids.holder}
                className="text-input"
                value={holderChoice}
                onChange={(event) => setHolderChoice(event.target.value)}
              >
                <option value="">{t('quotas.holder_placeholder')}</option>
                {holders.map((candidate) => (
                  <option key={holderKey(candidate)} value={holderKey(candidate)}>
                    {holderLabel({
                      holderUserId: candidate.userId,
                      holderDeviceId: candidate.deviceId,
                    })}
                  </option>
                ))}
              </select>
              <p className="home-muted">{t('quotas.holder_hint')}</p>
              {page.historyMore ? (
                <p className="home-muted">
                  {t('quotas.holder_partial', { count: page.history.length })}
                </p>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor={ids.product}>{t('quotas.product_label')}</label>
              <select
                id={ids.product}
                className="text-input"
                value={productChoice}
                onChange={(event) => setProductChoice(event.target.value)}
              >
                <option value="">{t('quotas.product_placeholder')}</option>
                {stocked.map((candidate) => (
                  <option key={candidate.id} value={candidate.id} disabled={held.has(candidate.id)}>
                    {held.has(candidate.id)
                      ? t('quotas.product_held', { name: candidate.name })
                      : candidate.name}
                  </option>
                ))}
              </select>
              {product && room ? (
                <>
                  <p className="home-muted">
                    {t('quotas.unallocated', {
                      quantity: formatQuantity(room.capacity),
                      unit: unitLabel(product.base_unit_code, room.capacity, refs.units),
                    })}
                  </p>
                  {room.overcommitted > 0 ? (
                    <p className="text-warn">
                      {t('quotas.overcommitted', {
                        quantity: formatQuantity(room.overcommitted),
                        unit: unitLabel(product.base_unit_code, room.overcommitted, refs.units),
                      })}
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor={ids.quantity}>
                {product
                  ? t('quotas.quantity_label', {
                      unit: unitLabel(product.base_unit_code, 1, refs.units),
                    })
                  : t('quotas.quantity_label_no_unit')}
              </label>
              <input
                id={ids.quantity}
                className="text-input"
                inputMode="decimal"
                value={quantityText}
                onChange={(event) => setQuantityText(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.hours}>{t('quotas.hours_label')}</label>
              <input
                id={ids.hours}
                className="text-input"
                inputMode="decimal"
                value={hoursText}
                aria-invalid={hoursInvalid}
                aria-describedby={ids.hoursHelp}
                onChange={(event) => setHoursText(event.target.value)}
              />
              <p id={ids.hoursHelp} className={hoursInvalid ? 'error-message' : 'home-muted'}>
                {t(hoursInvalid ? 'quotas.hours_invalid' : 'quotas.hours_hint')}
              </p>
            </div>
            <ActionBar>
              <Button
                size="lg"
                className="submit-sale"
                disabled={blocked || !holder || !product || quantity === null || hoursInvalid}
                onClick={grant}
              >
                {busy ? t('sales.submitting') : t('quotas.grant_submit')}
              </Button>
            </ActionBar>
          </section>
        </>
      )}
    </section>
  );
}
