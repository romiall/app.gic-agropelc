/**
 * ECR-STK-02 « TRANSFÉRER (expédier) » (magasinier, responsable de ferme ; expédition vers un
 * commercial comprise). Demandes reçues à expédier ou à refuser, expédition directe d'un emplacement
 * de l'appareil vers un autre, et mouvement interne vers un autre emplacement du même site.
 * Commandes `inventory.transfer.dispatch`, `.decline` et `.move_internal` (agrégat `STOCK_TRANSFER`),
 * utilisables hors ligne ; le numéro `TRF-…` est lu dans le jeu `transfers` au tirage suivant. La
 * marchandise expédiée quitte aussitôt le disponible local et part en transit jusqu'à sa réception
 * (ECR-STK-03) ; celle d'un mouvement interne passe aussitôt sur la destination. Une expédition de
 * demande que le serveur n'accepte pas (demande plus à expédier, S-40) reste proposée à la ressaisie
 * en expédition directe tant qu'elle n'est ni ressaisie ni écartée.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ROUTES } from '../../app/screens.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { localAvailable, physicalLeft, stockKey } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import type { LocationData, StockTransferData } from '../sales/types.js';
import { offlineExitGuard } from '../sales/quota.js';
import { guardBlocks, guardDescribedBy } from './exit-guard.js';
import { ExitGuardMessages } from './ExitGuardMessages.js';
import { LinesEditor } from './LinesEditor.js';
import { stockLocations } from './stock-view.js';
import {
  computeLines,
  declinePayload,
  destinations,
  directDispatchPayload,
  DISMISSED_FLAG,
  internalDestinations,
  internalMovePayload,
  lotsAt,
  movableByHolder,
  MAX_CARRIER_NAME,
  MAX_DECLINE_COMMENT,
  MAX_TRANSFER_NOTES,
  overAvailable,
  parseDispatched,
  prefillStillRefused,
  REENTERED_FLAG,
  refusedDispatches,
  requestDispatchPayload,
  requestsToDispatch,
  totalsByProduct,
  type RefusedDispatch,
  type TransferLineDraft,
  type TransferPrefill,
} from './transfer.js';

function availableAt(refs: SalesReferences, location: LocationData, productId: string): number {
  return localAvailable(
    refs.stock.get(stockKey(location.id, productId)),
    location.custody_mode,
    refs.pending.get(stockKey(location.id, productId)) ?? 0,
  );
}

/** Contrôle de l'expédition : le physique moins les opérations en attente, comme le serveur. */
function physicalAt(refs: SalesReferences, location: LocationData, productId: string): number {
  return physicalLeft(
    refs.stock.get(stockKey(location.id, productId)),
    refs.pending.get(stockKey(location.id, productId)) ?? 0,
  );
}

const newLine = (): TransferLineDraft => ({
  key: idGenerator.newId(),
  productId: '',
  unitCode: '',
  quantityText: '',
});

/** Brouillon sans lot désigné. */
function withoutLot(line: TransferLineDraft): TransferLineDraft {
  const { lotId, ...rest } = line;
  void lotId;
  return rest;
}

/** Pose un indice local sur des expéditions refusées : ressaisies, ou écartées par l'utilisateur. */
async function flagRefused(commandIds: readonly string[], flag: string): Promise<void> {
  const db = getDb();
  await db.transaction('rw', db.outbox, async () => {
    for (const commandId of commandIds) {
      const command = await db.outbox.get(commandId);
      if (!command || command.local_flags?.includes(flag)) continue;
      await db.outbox.update(commandId, { local_flags: [...(command.local_flags ?? []), flag] });
    }
  });
}

/** Vrai si une des expéditions refusées d'origine n'est encore ni ressaisie ni écartée. */
async function originsStillOpen(commandIds: readonly string[]): Promise<boolean> {
  const origins = await getDb().outbox.bulkGet([...commandIds]);
  return origins.some(
    (command) =>
      command !== undefined &&
      !command.local_flags?.includes(REENTERED_FLAG) &&
      !command.local_flags?.includes(DISMISSED_FLAG),
  );
}

/** Messages du résultat selon l'opération. */
type ResultMessages = 'transfer.result' | 'transfer.decline_result' | 'transfer.move_result';

interface FormProps {
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly online: boolean;
  readonly onDone: (commandId: string, messages: ResultMessages) => void;
}

/** Expédition directe ou mouvement interne. */
type Mode = 'DISPATCH' | 'MOVE';

/** Transporteur, et note pour une expédition directe (la note d'une demande n'est pas conservée). */
function CarrierFields(props: {
  readonly carrier: string;
  readonly onCarrier: (value: string) => void;
  readonly notes?: string;
  readonly onNotes?: (value: string) => void;
}) {
  const { t } = useTranslation();
  const carrierId = useId();
  const notesId = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={carrierId}>{t('transfer.carrier_label')}</label>
        <input
          id={carrierId}
          className="text-input"
          maxLength={MAX_CARRIER_NAME}
          value={props.carrier}
          onChange={(event) => props.onCarrier(event.target.value)}
        />
      </div>
      {props.onNotes ? (
        <div className="field">
          <label htmlFor={notesId}>{t('transfer.notes_label')}</label>
          <textarea
            id={notesId}
            className="text-input"
            rows={2}
            maxLength={MAX_TRANSFER_NOTES}
            value={props.notes ?? ''}
            onChange={(event) => props.onNotes?.(event.target.value)}
          />
        </div>
      ) : null}
    </>
  );
}

function OverAvailable({
  online,
  names,
  mode = 'DISPATCH',
}: {
  online: boolean;
  names: readonly string[];
  mode?: Mode;
}) {
  const { t } = useTranslation();
  if (names.length === 0) return null;
  const prefix = mode === 'MOVE' ? 'transfer.move_over' : 'transfer.over';
  return online ? (
    <p className="error-message" role="alert">
      {t(`${prefix}_online`, { products: names.join(', ') })}
    </p>
  ) : (
    <p className="text-warn">{t(`${prefix}_offline`, { products: names.join(', ') })}</p>
  );
}

function DirectDispatchForm({
  refs,
  userId,
  deviceId,
  online,
  onDone,
  mode,
  prefill,
  onReentryDone,
}: FormProps & {
  readonly mode: Mode;
  readonly deviceId: string | undefined;
  readonly prefill?: TransferPrefill | undefined;
  /** Expédition d'origine ressaisie ou écartée entre-temps : rien n'est envoyé. */
  readonly onReentryDone: () => void;
}) {
  const { t } = useTranslation();
  // Mouvement interne : sources sous la garde de l'utilisateur ou de l'appareil, hors stock mobile.
  const sources = stockLocations(refs).filter(
    (location) => mode !== 'MOVE' || movableByHolder(location, userId, deviceId),
  );
  const [sourceChoice, setSourceChoice] = useState<string | null>(
    () => prefill?.fromLocationId ?? null,
  );
  const [destinationId, setDestinationId] = useState(() => prefill?.toLocationId ?? '');
  const [lines, setLines] = useState<readonly TransferLineDraft[]>(() =>
    prefill && prefill.lines.length > 0
      ? prefill.lines.map((line) => ({
          ...newLine(),
          productId: line.productId,
          // Quantité de l'expédition refusée, en unité de base (l'unité de la demande n'est pas
          // reprise : la quantité y serait multipliée par le facteur).
          unitCode: '',
          quantityText: String(line.quantityBase),
        }))
      : [newLine()],
  );
  const [carrier, setCarrier] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // Expéditions d'origine figées au montage : le préremplissage peut disparaître de l'écran (autre
  // onglet) alors que le formulaire le porte encore.
  const [origins] = useState(() => prefill?.originCommandIds ?? null);
  const sourceSelectId = useId();
  const destinationSelectId = useId();

  const source = sources.find((candidate) => candidate.id === sourceChoice) ?? sources[0];
  if (!source) return <p className="home-muted">{t('stock.no_location')}</p>;

  const targets =
    mode === 'MOVE'
      ? internalDestinations(refs.locations, source, userId, deviceId)
      : destinations(refs.locations, source.id);
  const products = refs.products
    .filter((product) => refs.stock.has(stockKey(source.id, product.id)))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const productNames = new Map(refs.products.map((product) => [product.id, product.name]));
  const checks = computeLines(lines, products, refs);
  const totals = totalsByProduct(
    checks.map(({ check }) => ({
      productId: check.draft.productId,
      quantityBase: check.quantityBase,
    })),
  );
  // Mouvement interne : le lot se désigne quand la source en compte plusieurs (sinon le serveur
  // déplacerait le plus ancien) ; la quantité se contrôle contre le solde de ce lot.
  const lotChoices = (productId: string) =>
    mode === 'MOVE' && productId ? lotsAt(refs, source.id, productId) : [];
  // Lot désigné encore proposé pour le produit de la ligne (sinon il n'est ni compté ni envoyé).
  const lotValid = (draft: TransferLineDraft) =>
    !!draft.lotId && lotChoices(draft.productId).some((lot) => lot.lotId === draft.lotId);
  const lotMissing = (draft: TransferLineDraft) =>
    lotChoices(draft.productId).length > 1 && !lotValid(draft);
  // Total par lot désigné, en millièmes comme totalsByProduct.
  const lotTotals = new Map<string, number>();
  for (const { check } of checks) {
    if (!lotValid(check.draft) || check.quantityBase === null) continue;
    const key = `${check.draft.productId}|${check.draft.lotId}`;
    lotTotals.set(key, (lotTotals.get(key) ?? 0) + Math.round(check.quantityBase * 1000));
  }
  const lotOf = (key: string) => {
    const [productId = '', lotId] = key.split('|');
    return lotChoices(productId).find((candidate) => candidate.lotId === lotId);
  };
  const lotOver = [...lotTotals].filter(
    ([key, milli]) => milli > Math.round((lotOf(key)?.quantity ?? 0) * 1000),
  );
  // Lot désigné que des sorties en attente sans lot (le plus ancien d'abord au serveur) pourraient
  // épuiser : avertissement seulement.
  const lotRisk = [...lotTotals].some(([key, milli]) => {
    const lot = lotOf(key);
    return (
      lot !== undefined &&
      milli <= Math.round(lot.quantity * 1000) &&
      milli > Math.round(lot.cautious * 1000)
    );
  });
  // Dépassement du produit sur la source, ou du lot désigné : bloqué en ligne, signalé hors ligne.
  const over = [
    ...new Set([
      ...overAvailable(totals, (productId) => physicalAt(refs, source, productId)),
      ...lotOver.map(([key]) => key.split('|')[0] ?? ''),
    ]),
  ];
  // Garde hors ligne de la source (BR-STK-013, AV-231) : quota du détenteur, solde exclusif. Le
  // mouvement interne n'y est pas soumis : le serveur ne lui impute aucun quota (`INTERNAL_MOVE`).
  const guard = offlineExitGuard(refs, {
    kind: 'DISPATCH',
    location: source,
    requested: online || mode === 'MOVE' ? new Map() : totals,
    userId,
    deviceId,
    now: clock.now(),
  });
  const ready =
    destinationId !== '' &&
    targets.some((target) => target.id === destinationId) &&
    checks.every(({ check }) => check.issue === null && !lotMissing(check.draft)) &&
    guard.blocks.length === 0 &&
    !(online && over.length > 0) &&
    !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      // Expédition refusée ressaisie ou écartée entre-temps (autre onglet) : pas de seconde
      // expédition pour la même sortie physique.
      if (mode === 'DISPATCH' && origins && !(await originsStillOpen(origins))) {
        onReentryDone();
        return;
      }
      // Un lot désigné qui n'est plus proposé n'est pas envoyé (le serveur prend le plus ancien).
      const lineChecks = checks.map(({ check }) =>
        check.draft.lotId && !lotValid(check.draft)
          ? { ...check, draft: withoutLot(check.draft) }
          : check,
      );
      const command = await submitCommand(
        mode === 'MOVE'
          ? {
              authorUserId: userId,
              commandType: 'inventory.transfer.move_internal',
              aggregateType: 'STOCK_TRANSFER',
              payload: internalMovePayload({
                fromLocationId: source.id,
                toLocationId: destinationId,
                lines: lineChecks,
                notes,
              }),
            }
          : {
              authorUserId: userId,
              commandType: 'inventory.transfer.dispatch',
              aggregateType: 'STOCK_TRANSFER',
              payload: directDispatchPayload({
                fromLocationId: source.id,
                toLocationId: destinationId,
                lines: lineChecks,
                carrierName: carrier,
                notes,
              }),
            },
      );
      if (mode === 'DISPATCH' && origins) {
        // Expédition refusée d'origine marquée ressaisie ; en cas d'échec elle reste proposée, et
        // l'utilisateur peut l'écarter.
        await flagRefused(origins, REENTERED_FLAG).catch(() => undefined);
      }
      onDone(command.command_id, mode === 'MOVE' ? 'transfer.move_result' : 'transfer.result');
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale-block" aria-labelledby="transfer-direct-title">
      <h2 id="transfer-direct-title">
        {mode === 'MOVE' ? t('transfer.move_title') : t('transfer.direct_title')}
      </h2>
      {mode === 'MOVE' ? <p className="home-muted">{t('transfer.move_hint')}</p> : null}
      <div className="field">
        <label htmlFor={sourceSelectId}>{t('transfer.source_label')}</label>
        <select
          id={sourceSelectId}
          className="text-input"
          value={source.id}
          onChange={(event) => {
            setSourceChoice(event.target.value);
            setDestinationId('');
            setLines([newLine()]);
          }}
        >
          {sources.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={destinationSelectId}>{t('transfer.destination_label')}</label>
        <select
          id={destinationSelectId}
          className="text-input"
          value={destinationId}
          onChange={(event) => setDestinationId(event.target.value)}
        >
          <option value="">{t('transfer.destination_placeholder')}</option>
          {targets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>

      <LinesEditor
        rows={checks}
        products={products}
        onUpdate={(key, patch) =>
          setLines((current) =>
            current.map((line) => {
              if (line.key !== key) return line;
              const next = { ...line, ...patch };
              // Le lot désigné ne suit pas un changement de produit.
              return patch.productId !== undefined && patch.productId !== line.productId
                ? withoutLot(next)
                : next;
            }),
          )
        }
        onRemove={(key) =>
          setLines((current) => current.filter((candidate) => candidate.key !== key))
        }
        onAdd={() => setLines((current) => [...current, newLine()])}
        hint={(product) =>
          t('sales.product_available', {
            quantity: formatQuantity(availableAt(refs, source, product.id)),
            unit: unitLabel(
              product.base_unit_code,
              availableAt(refs, source, product.id),
              refs.units,
            ),
          })
        }
        lineIssue={(row) => (lotMissing(row.check.draft) ? t('transfer.lot_required') : null)}
        quantityDescribedBy={(row) =>
          guardDescribedBy(guard, 'transfer-direct', row.check.draft.productId)
        }
        quantityBlocked={(row) => guardBlocks(guard, row.check.draft.productId)}
        extra={(row) => {
          const lots = lotChoices(row.check.draft.productId);
          if (lots.length <= 1) return null;
          const lotFieldId = `${row.check.draft.key}-lot`;
          const missing = lotMissing(row.check.draft);
          return (
            <div className="field">
              <label htmlFor={lotFieldId}>{t('transfer.lot_label')}</label>
              <select
                id={lotFieldId}
                className="text-input"
                aria-invalid={missing}
                aria-describedby={missing ? `${row.check.draft.key}-issue` : undefined}
                value={row.check.draft.lotId ?? ''}
                onChange={(event) =>
                  setLines((current) =>
                    current.map((line) =>
                      line.key === row.check.draft.key
                        ? { ...line, lotId: event.target.value }
                        : line,
                    ),
                  )
                }
              >
                <option value="">{t('lot_setup.choose')}</option>
                {lots.map((lot) => (
                  <option key={lot.lotId} value={lot.lotId}>
                    {t('transfer.lot_option', {
                      code: lot.lotCode,
                      quantity: formatQuantity(lot.quantity),
                      unit: unitLabel(row.product?.base_unit_code ?? '', lot.quantity, refs.units),
                    })}
                  </option>
                ))}
              </select>
            </div>
          );
        }}
      />
      {mode === 'MOVE' && targets.length === 0 ? (
        <p className="alert alert-error" role="alert">
          {t('transfer.move_no_destination')}
        </p>
      ) : null}
      {mode === 'MOVE' ? (
        <NotesField notes={notes} onNotes={setNotes} />
      ) : (
        <CarrierFields carrier={carrier} notes={notes} onCarrier={setCarrier} onNotes={setNotes} />
      )}
      <ExitGuardMessages
        guard={guard}
        idPrefix="transfer-direct"
        productName={(productId) => productNames.get(productId) ?? productId}
        unitOf={(productId) =>
          refs.products.find((candidate) => candidate.id === productId)?.base_unit_code ?? ''
        }
      />
      <OverAvailable
        online={online}
        mode={mode}
        names={over
          .filter((productId) => online || !guardBlocks(guard, productId))
          .map((productId) => productNames.get(productId) ?? productId)}
      />
      {lotRisk ? <p className="text-warn">{t('transfer.lot_fifo_risk')}</p> : null}
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
        {busy
          ? t('sales.submitting')
          : mode === 'MOVE'
            ? t('transfer.move_submit')
            : t('transfer.submit')}
      </button>
    </section>
  );
}

function NotesField({ notes, onNotes }: { notes: string; onNotes: (value: string) => void }) {
  const { t } = useTranslation();
  const notesId = useId();
  return (
    <div className="field">
      <label htmlFor={notesId}>{t('transfer.notes_label')}</label>
      <textarea
        id={notesId}
        className="text-input"
        rows={2}
        maxLength={MAX_TRANSFER_NOTES}
        value={notes}
        onChange={(event) => onNotes(event.target.value)}
      />
    </div>
  );
}

/** Refus d'une demande reçue, commentaire facultatif (SM-TRANSFER `REQUESTED → DECLINED`). */
function DeclineBlock({
  userId,
  online,
  onDone,
  transfer,
}: Pick<FormProps, 'userId' | 'onDone' | 'online'> & { readonly transfer: StockTransferData }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const commentId = useId();
  const offlineHintId = useId();
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  // Focus porté sur le motif à l'ouverture, rendu au bouton à la fermeture.
  useEffect(() => {
    if (open) {
      opened.current = true;
      commentRef.current?.focus();
    } else if (opened.current) {
      openRef.current?.focus();
    }
  }, [open]);
  const ready = online && comment.trim() !== '' && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.transfer.decline',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: transfer.id,
        payload: declinePayload(transfer, comment),
      });
      onDone(command.command_id, 'transfer.decline_result');
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        <button
          ref={openRef}
          type="button"
          className="secondary"
          disabled={!online}
          aria-describedby={!online ? offlineHintId : undefined}
          onClick={() => setOpen(true)}
        >
          {t('transfer.decline_open')}
        </button>
        {!online ? (
          <p id={offlineHintId} className="home-muted">
            {t('transfer.decline_online_only')}
          </p>
        ) : null}
      </>
    );
  }
  return (
    <section className="sale-block" aria-labelledby="transfer-decline-title">
      <h2 id="transfer-decline-title">{t('transfer.decline_title')}</h2>
      <p className="home-muted">{t('transfer.decline_hint')}</p>
      <div className="field">
        <label htmlFor={commentId}>{t('transfer.decline_comment_label')}</label>
        <textarea
          ref={commentRef}
          id={commentId}
          className="text-input"
          rows={2}
          maxLength={MAX_DECLINE_COMMENT}
          aria-required="true"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>
      {!online ? (
        <p className="text-warn" role="status">
          {t('transfer.decline_online_only')}
        </p>
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <div className="result-actions">
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          {t('transfer.decline_cancel')}
        </button>
        <button type="button" disabled={!ready} onClick={() => void submit()}>
          {busy ? t('sales.submitting') : t('transfer.decline_submit')}
        </button>
      </div>
    </section>
  );
}

/**
 * Expédition de demande refusée par le serveur (S-40) : ressaisie en expédition directe, sur
 * confirmation d'une expédition réelle quand la demande est déjà expédiée ailleurs ou inconnue de
 * l'appareil ; ou écartée.
 */
function RefusedDispatchCard({
  refused,
  onReenter,
}: {
  readonly refused: RefusedDispatch;
  readonly onReenter: (prefill: TransferPrefill) => void;
}) {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const confirmId = useId();
  const needsConfirm = refused.kind === 'ALREADY_DISPATCHED' || refused.kind === 'UNKNOWN';
  const canReenter = refused.kind !== 'NOT_REREAD' && refused.prefill.lines.length > 0;

  const dismiss = async () => {
    setBusy(true);
    setSaveError(false);
    try {
      await flagRefused(refused.commandIds, DISMISSED_FLAG);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="line-card"
      aria-label={t('transfer.refused_label', { doc: refused.docNumber ?? '' })}
    >
      <p>{t(`transfer.refused.${refused.kind}`, { doc: refused.docNumber ?? '' })}</p>
      {canReenter && needsConfirm ? (
        <label className="choice" htmlFor={confirmId}>
          <input
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {t(`transfer.refused_confirm.${refused.kind}`)}
        </label>
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <div className="result-actions">
        {canReenter ? (
          <button
            type="button"
            disabled={needsConfirm && !confirmed}
            onClick={() => onReenter(refused.prefill)}
          >
            {t('transfer.reenter_direct')}
          </button>
        ) : null}
        <button type="button" className="secondary" disabled={busy} onClick={() => void dismiss()}>
          {t('transfer.refused_dismiss')}
        </button>
      </div>
    </li>
  );
}

function RefusedDispatchList({
  refused,
  onReenter,
}: {
  readonly refused: readonly RefusedDispatch[];
  readonly onReenter: (prefill: TransferPrefill) => void;
}) {
  const { t } = useTranslation();
  if (refused.length === 0) return null;
  return (
    <section className="sale-block" aria-labelledby="transfer-refused-title">
      <h2 id="transfer-refused-title">{t('transfer.refused_title')}</h2>
      <ul className="line-list">
        {refused.map((entry) => (
          <RefusedDispatchCard key={entry.commandId} refused={entry} onReenter={onReenter} />
        ))}
      </ul>
    </section>
  );
}

function RequestDispatchForm({
  refs,
  userId,
  deviceId,
  online,
  onDone,
  transfer,
}: FormProps & { readonly transfer: StockTransferData; readonly deviceId: string | undefined }) {
  const { t } = useTranslation();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [carrier, setCarrier] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const source = refs.locations.find((location) => location.id === transfer.from_location_id);
  const destination = refs.locations.find((location) => location.id === transfer.to_location_id);
  const productNames = new Map(refs.products.map((product) => [product.id, product]));

  const quantities = new Map<string, number>();
  let invalid = false;
  for (const line of transfer.lines) {
    const text = texts[line.id] ?? formatQuantity(Number(line.requested_qty_base ?? 0));
    const value = parseDispatched(text.replace(/\s/g, ''));
    if (value === null) invalid = true;
    else quantities.set(line.id, value);
  }
  const totals = totalsByProduct(
    transfer.lines.map((line) => ({
      productId: line.product_id,
      quantityBase: quantities.get(line.id) ?? null,
    })),
  );
  const over = source
    ? overAvailable(totals, (productId) => physicalAt(refs, source, productId))
    : [];
  const nothing = [...quantities.values()].every((value) => value === 0);
  // Garde hors ligne de la source (BR-STK-013, AV-231).
  const guard = source
    ? offlineExitGuard(refs, {
        kind: 'DISPATCH',
        location: source,
        requested: online ? new Map() : totals,
        userId,
        deviceId,
        now: clock.now(),
      })
    : { blocks: [], signals: [] };
  const ready =
    !invalid && !nothing && guard.blocks.length === 0 && !(online && over.length > 0) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.transfer.dispatch',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: transfer.id,
        payload: requestDispatchPayload(transfer, quantities, carrier),
      });
      onDone(command.command_id, 'transfer.result');
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale-block" aria-labelledby="transfer-request-title">
      <h2 id="transfer-request-title">
        {t('transfer.request_title', { doc: transfer.doc_number })}
      </h2>
      <p className="home-muted">
        {t('transfer.route', { from: source?.name ?? '', to: destination?.name ?? '' })}
      </p>
      <ul className="line-list">
        {transfer.lines.map((line) => {
          const product = productNames.get(line.product_id);
          const unit = product?.base_unit_code ?? line.unit_code;
          const text = texts[line.id] ?? formatQuantity(Number(line.requested_qty_base ?? 0));
          return (
            <li key={line.id} className="line-card" aria-label={product?.name ?? line.product_id}>
              <div className="line-head">
                <strong>{product?.name ?? line.product_id}</strong>
                <span>
                  {t('transfer.requested', {
                    quantity: formatQuantity(Number(line.requested_qty_base ?? 0)),
                    unit: unitLabel(unit, Number(line.requested_qty_base ?? 0)),
                  })}
                </span>
              </div>
              <div className="field">
                <label htmlFor={`dispatch-${line.id}`}>
                  {t('transfer.dispatched_label', { unit: unitLabel(unit) })}
                </label>
                <input
                  id={`dispatch-${line.id}`}
                  className="text-input"
                  inputMode="decimal"
                  aria-invalid={guardBlocks(guard, line.product_id) ? true : undefined}
                  aria-describedby={guardDescribedBy(guard, 'transfer-request', line.product_id)}
                  value={text}
                  onChange={(event) =>
                    setTexts((current) => ({ ...current, [line.id]: event.target.value }))
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>
      {invalid ? <p className="error-message">{t('loss.issue.QUANTITY_INVALID')}</p> : null}
      {nothing && !invalid ? <p className="text-warn">{t('transfer.nothing')}</p> : null}
      <CarrierFields carrier={carrier} onCarrier={setCarrier} />
      <ExitGuardMessages
        guard={guard}
        idPrefix="transfer-request"
        productName={(productId) => productNames.get(productId)?.name ?? productId}
        unitOf={(productId) => productNames.get(productId)?.base_unit_code ?? ''}
      />
      <OverAvailable
        online={online}
        names={over
          .filter((productId) => online || !guardBlocks(guard, productId))
          .map((productId) => productNames.get(productId)?.name ?? productId)}
      />
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
        {busy ? t('sales.submitting') : t('transfer.submit_request')}
      </button>
      <DeclineBlock userId={userId} online={online} onDone={onDone} transfer={transfer} />
    </section>
  );
}

export function TransferScreen() {
  const { t } = useTranslation();
  const { transferId } = useParams();
  const { state, deviceId } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const statePrefill = (location.state as { prefill?: TransferPrefill } | null)?.prefill;
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  // Résultat attaché à la route où l'opération a été saisie.
  const [submitted, setSubmitted] = useState<{
    commandId: string;
    route: string | undefined;
    messages: ResultMessages;
  }>();
  const [mode, setMode] = useState<Mode>('DISPATCH');
  // Ressaisie arrêtée à l'envoi (expédition d'origine ressaisie ou écartée entre-temps).
  const [reentryNotice, setReentryNotice] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.transfer')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  // Expéditions de demande refusées par le serveur parce que la demande n'est plus à expédier
  // (S-40), tirées de l'outbox : proposées à la ressaisie tant qu'elles ne sont ni ressaisies ni
  // écartées, même après avoir quitté l'écran de résultat.
  const refused = refusedDispatches(refs, userId);
  const refusedHere = submitted
    ? (refused.find((entry) => entry.commandIds.includes(submitted.commandId)) ?? null)
    : null;
  // Préremplissage encore valable seulement : une entrée d'historique plus ancienne peut porter celui
  // d'une expédition déjà ressaisie.
  const prefill =
    statePrefill && prefillStillRefused(refs, statePrefill) ? statePrefill : undefined;
  const reenter = (next: TransferPrefill) => {
    setSubmitted(undefined);
    setReentryNotice(false);
    setMode('DISPATCH');
    // Depuis la page Transférer, la ressaisie remplace l'entrée courante (pas d'entrées préremplies
    // empilées par deux touchers).
    navigate(ROUTES.transfer, {
      state: { prefill: next },
      replace: location.pathname === ROUTES.transfer,
    });
  };

  if (submitted && submitted.route === transferId) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.transfer')}</h1>
        <CommandResult commandId={submitted.commandId} messages={submitted.messages}>
          <Link
            to={ROUTES.transfer}
            className="action action-compact"
            onClick={() => setSubmitted(undefined)}
          >
            <span className="action-label">{t('transfer.another')}</span>
          </Link>
        </CommandResult>
        {refusedHere ? <RefusedDispatchList refused={[refusedHere]} onReenter={reenter} /> : null}
      </section>
    );
  }

  const onDone = (commandId: string, messages: ResultMessages) => {
    setSubmitted({ commandId, route: transferId, messages });
    setReentryNotice(false);
    // Préremplissage consommé : un retour arrière ne repropose pas la même expédition.
    if (statePrefill) navigate(location.pathname, { replace: true, state: null });
  };
  const requests = requestsToDispatch(refs);
  const locations = new Map(refs.locations.map((location) => [location.id, location]));

  if (transferId) {
    const entry = requests.find((candidate) => candidate.transfer.id === transferId);
    return (
      <section className="sale">
        <Link to={ROUTES.transfer} className="back-link">
          {t('transfer.back')}
        </Link>
        <h1>{t('nav.screens.transfer')}</h1>
        {!online ? (
          <p className="home-banner" role="status">
            {t('transfer.offline_banner')}
          </p>
        ) : null}
        {refused.some((candidate) => candidate.transferId === transferId) ? (
          // Le serveur a refusé une expédition de cette demande : elle n'est plus à expédier, même
          // si l'appareil ne l'a pas encore relue.
          <RefusedDispatchList
            refused={refused.filter((candidate) => candidate.transferId === transferId)}
            onReenter={reenter}
          />
        ) : !entry ? (
          <p className="alert alert-error">{t('transfer.not_found')}</p>
        ) : entry.dispatching ? (
          <p className="home-muted">{t('transfer.dispatching')}</p>
        ) : entry.declining ? (
          <p className="home-muted">{t('transfer.declining')}</p>
        ) : (
          <RequestDispatchForm
            refs={refs}
            userId={userId}
            deviceId={deviceId}
            online={online}
            onDone={onDone}
            transfer={entry.transfer}
          />
        )}
      </section>
    );
  }

  return (
    <section className="sale">
      <h1>{t('nav.screens.transfer')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('transfer.offline_banner')}
        </p>
      ) : null}
      <RefusedDispatchList refused={refused} onReenter={reenter} />
      <section className="sale-block" aria-labelledby="transfer-requests-title">
        <h2 id="transfer-requests-title">{t('transfer.requests_title')}</h2>
        {requests.length === 0 ? (
          <p className="home-muted">{t('transfer.no_request')}</p>
        ) : (
          <ul className="doc-list">
            {requests.map(({ transfer, dispatching, declining }) => (
              <li key={transfer.id}>
                <Link
                  to={ROUTES.transferOne(transfer.id)}
                  className="doc-row"
                  aria-label={t('transfer.open_request', { doc: transfer.doc_number })}
                >
                  <span className="doc-main">
                    <strong>{transfer.doc_number}</strong>
                    <small>
                      {t('transfer.route', {
                        from: locations.get(transfer.from_location_id)?.name ?? '',
                        to: locations.get(transfer.to_location_id)?.name ?? '',
                      })}
                    </small>
                  </span>
                  <span className="doc-side">
                    {dispatching ? (
                      <span className="badge badge-warn">{t('transfer.dispatching_badge')}</span>
                    ) : declining ? (
                      <span className="badge badge-warn">{t('transfer.declining_badge')}</span>
                    ) : (
                      <span className="badge badge-info">
                        {t('transfer.lines_count', { count: transfer.lines.length })}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <fieldset className="choice-group">
        <legend>{t('transfer.mode_label')}</legend>
        {(['DISPATCH', 'MOVE'] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="transfer-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {t(`transfer.mode.${value}`)}
          </label>
        ))}
      </fieldset>
      {reentryNotice ? (
        <p className="alert alert-error" role="alert">
          {t('transfer.reentry_done')}
        </p>
      ) : null}
      {mode === 'DISPATCH' && prefill ? (
        <p className="home-muted">{t('transfer.reenter_hint')}</p>
      ) : null}
      <DirectDispatchForm
        key={`${mode}:${location.key}`}
        refs={refs}
        userId={userId}
        deviceId={deviceId}
        online={online}
        onDone={onDone}
        mode={mode}
        prefill={mode === 'DISPATCH' ? prefill : undefined}
        onReentryDone={() => {
          // Formulaire remonté vide (préremplissage consommé), annonce au-dessus.
          setReentryNotice(true);
          navigate(location.pathname, { replace: true, state: null });
        }}
      />
    </section>
  );
}
