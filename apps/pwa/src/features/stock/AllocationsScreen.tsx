/**
 * ECR-STK-06 « Quotas » (magasinier, responsable de ferme, responsable commercial, Direction :
 * `inventory.allocation.manage`). En ligne seulement : sur un emplacement partagé, accorder un quota à
 * un couple (utilisateur, appareil) déjà connu (AV-310, S-28), l'augmenter (version attendue,
 * ADR-033 §9) ou le révoquer avec un motif (BR-STK-014). La libération est faite par le détenteur, sur
 * l'accueil du PDV (AV-309). Le serveur contrôle le disponible (`ALLOCATION_EXCEEDS_AVAILABLE`).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { stockKey } from '../sales/stock.js';
import { isBlockingWait, phaseOf, submitCommand } from '../sales/submit.js';
import {
  activeQuotas,
  grantPayload,
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

export function AllocationsScreen() {
  const { t } = useTranslation();
  const { state, deviceId } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
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
  const ids = {
    location: useId(),
    holder: useId(),
    product: useId(),
    quantity: useId(),
    hours: useId(),
    edit: useId(),
  };

  const locations = refs
    ? stockLocations(refs).filter(
        (location) =>
          location.custody_mode !== 'EXCLUSIVE_USER' &&
          location.custody_mode !== 'EXCLUSIVE_DEVICE',
      )
    : [];
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  const lastCommand = refs?.outbox.find((command) => command.command_id === last?.commandId);
  const reloadKey = `${last?.commandId ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}`;
  const read = useOnlineRead<AllocationsPage>(
    online && location ? `/api/v1/allocations?location_id=${location.id}` : null,
    (path) => readPath<AllocationsPage>(path),
    online,
    reloadKey,
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.allocations')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.allocations')}</h1>
        <p className="home-muted">{t('quotas.online_only')}</p>
      </section>
    );
  }
  if (!location) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.allocations')}</h1>
        <p className="home-muted">{t('quotas.no_location')}</p>
      </section>
    );
  }

  const products = new Map(refs.products.map((product) => [product.id, product]));
  const page = read.data;
  const items = page?.allocations ?? [];
  const active = activeQuotas(items);
  const holders = knownHolders(items, deviceId ? { userId, deviceId } : null);
  const holder = holders.find((candidate) => holderKey(candidate) === holderChoice);
  const stocked = [...refs.stock.values()]
    .filter((balance) => balance.location_id === location.id)
    .map((balance) => products.get(balance.product_id))
    .filter((product): product is NonNullable<typeof product> => product !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = stocked.find((candidate) => candidate.id === productChoice);
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
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, kind });
      setEditing(null);
      setEditText('');
      if (kind === 'grant') {
        setQuantityText('');
        setHoursText('');
      }
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

  const holderLabel = (item: Pick<AllocationItem, 'holderUserId' | 'holderDeviceId'>) =>
    t('quotas.holder', {
      user: item.holderUserId === userId ? t('quotas.you') : shortId(item.holderUserId ?? ''),
      device:
        item.holderDeviceId === deviceId
          ? t('quotas.this_device')
          : shortId(item.holderDeviceId ?? ''),
    });

  return (
    <section className="sale">
      <h1>{t('nav.screens.allocations')}</h1>
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
            {active.length === 0 ? (
              <p className="home-muted">{t('quotas.active_empty')}</p>
            ) : (
              <ul className="line-list">
                {active.map((item) => {
                  const name = products.get(item.productId)?.name ?? '';
                  const unit = products.get(item.productId)?.base_unit_code ?? '';
                  const open = editing?.id === item.id ? editing.kind : null;
                  const increase = open === 'increase' ? parsePositiveQuantity(editText) : null;
                  return (
                    <li
                      key={item.id}
                      className="line-card"
                      aria-label={`${name} ${shortId(item.id)}`}
                    >
                      <p>
                        <strong>{name}</strong> · {holderLabel(item)}
                      </p>
                      <p className="home-muted">
                        {t(item.validUntil ? 'quotas.remaining_until' : 'quotas.remaining', {
                          remaining: formatQuantity(item.quantityRemaining),
                          granted: formatQuantity(item.quantityGranted),
                          unit,
                          until: item.validUntil ? formatDateTime(item.validUntil) : '',
                        })}
                      </p>
                      {item.revocationPending ? (
                        <p className="text-warn">{t('quotas.revocation_pending')}</p>
                      ) : null}
                      {open === null ? (
                        <div className="result-actions">
                          {!item.revocationPending ? (
                            <button
                              type="button"
                              className="secondary"
                              disabled={blocked}
                              onClick={() => {
                                setEditing({ id: item.id, kind: 'increase' });
                                setEditText('');
                              }}
                            >
                              {t('quotas.increase_open', { name })}
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
                            {t('quotas.revoke_open', { name })}
                          </button>
                        </div>
                      ) : (
                        <div className="field">
                          <label htmlFor={ids.edit}>
                            {t(
                              open === 'increase' ? 'quotas.increase_label' : 'quotas.reason_label',
                              {
                                unit,
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
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              {product ? (
                <p className="home-muted">
                  {t('quotas.unallocated', {
                    quantity: formatQuantity(
                      unallocated(
                        Number(refs.stock.get(stockKey(location.id, product.id))?.qty_on_hand ?? 0),
                        page,
                        product.id,
                      ),
                    ),
                    unit: product.base_unit_code,
                  })}
                </p>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor={ids.quantity}>
                {t('quotas.quantity_label', { unit: product?.base_unit_code ?? '' })}
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
                onChange={(event) => setHoursText(event.target.value)}
              />
              <p className={hoursInvalid ? 'error-message' : 'home-muted'}>
                {t(hoursInvalid ? 'quotas.hours_invalid' : 'quotas.hours_hint')}
              </p>
            </div>
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={blocked || !holder || !product || quantity === null || hoursInvalid}
              onClick={grant}
            >
              {busy ? t('sales.submitting') : t('quotas.grant_submit')}
            </button>
          </section>
        </>
      )}
    </section>
  );
}
