/**
 * Réception sans document (ECR-STK-03, BR-STK-024 ; P5-16) : marchandise arrivée sur un emplacement de
 * l'appareil sans transfert connu. Source, produits et quantités reçues ; le serveur la rapproche d'une
 * expédition de la même paire, ou la garde « non rapprochée » (signalée au bout de 48 h). Seulement sur
 * un emplacement exclusif (refus en ligne sinon, signalement hors ligne). Un transfert expédié connu de
 * l'appareil se reçoit avec son document. Commande `inventory.transfer.receive` sans `transferId`
 * (agrégat `STOCK_TRANSFER`, identifiant choisi par l'appareil), utilisable hors ligne.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ActionBar, Button, PageHeader } from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { LinesEditor } from './LinesEditor.js';
import {
  BLIND_RECEIPT_MAX_LINES,
  blindReceiptPayload,
  duplicateProducts,
  knownDispatch,
} from './receive.js';
import { receivingLocations } from './stock-view.js';
import {
  computeLines,
  destinations,
  MAX_TRANSFER_NOTES,
  type TransferLineDraft,
} from './transfer.js';

const newLine = (): TransferLineDraft => ({
  key: idGenerator.newId(),
  productId: '',
  unitCode: '',
  quantityText: '',
});

export function BlindReceiptScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [destinationChoice, setDestinationChoice] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [lines, setLines] = useState<readonly TransferLineDraft[]>(() => [newLine()]);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const destinationSelectId = useId();
  const sourceSelectId = useId();
  const notesId = useId();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('blind.title')} />
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        <PageHeader
          title={t('blind.title')}
          backTo={ROUTES.receive}
          backLabel={t('receive.back')}
        />
        <CommandResult commandId={submitted} messages="blind.result">
          <button
            type="button"
            onClick={() => {
              setLines([newLine()]);
              setNotes('');
              setSubmitted(undefined);
            }}
          >
            {t('blind.another')}
          </button>
        </CommandResult>
      </section>
    );
  }

  const held = receivingLocations(refs, userId);
  const destination = held.find((candidate) => candidate.id === destinationChoice) ?? held[0];
  if (!destination) {
    return (
      <section className="sale">
        <PageHeader
          title={t('blind.title')}
          backTo={ROUTES.receive}
          backLabel={t('receive.back')}
        />
        <p className="home-muted">{t('stock.no_location')}</p>
      </section>
    );
  }

  const sources = destinations(refs.locations, destination.id);
  // Un produit désactivé reste recevable (BR-CAT-006) : seul un service est écarté, comme au serveur.
  const products = refs.products
    .filter((product) => product.stock_family !== 'SERVICE')
    .map((product) =>
      product.status === 'ACTIVE'
        ? product
        : { ...product, name: t('blind.inactive_product', { name: product.name }) },
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const rows = computeLines(lines, products, refs);
  const duplicates = duplicateProducts(rows.map((row) => row.check.draft.productId));
  const exclusive =
    destination.custody_mode === 'EXCLUSIVE_USER' ||
    destination.custody_mode === 'EXCLUSIVE_DEVICE';
  const dispatch = sourceId ? knownDispatch(refs.transfers, sourceId, destination.id) : undefined;
  const lotRequired = rows.some((row) => row.product?.lot_tracking === 'REQUIRED');
  const ready =
    sourceId !== '' &&
    !dispatch &&
    rows.every((row) => row.check.issue === null) &&
    duplicates.size === 0 &&
    rows.length <= BLIND_RECEIPT_MAX_LINES &&
    !(online && !exclusive) &&
    !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.transfer.receive',
        aggregateType: 'STOCK_TRANSFER',
        payload: blindReceiptPayload({
          fromLocationId: sourceId,
          toLocationId: destination.id,
          lines: rows.map((row) => ({
            productId: row.check.draft.productId,
            unitCode: row.check.draft.unitCode,
            receivedQtyBase: row.check.quantityBase as number,
          })),
          notes,
        }),
      });
      setSubmitted(command.command_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <PageHeader title={t('blind.title')} backTo={ROUTES.receive} backLabel={t('receive.back')} />
      <p className="home-muted">{t('blind.hint')}</p>
      {!online ? (
        <p className="home-banner" role="status">
          {t('blind.offline_banner')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={destinationSelectId}>{t('blind.destination_label')}</label>
        <select
          id={destinationSelectId}
          className="text-input"
          value={destination.id}
          onChange={(event) => {
            setDestinationChoice(event.target.value);
            setSourceId('');
          }}
        >
          {held.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {!exclusive ? (
        online ? (
          <p className="error-message" role="alert">
            {t('blind.not_exclusive_online')}
          </p>
        ) : (
          <p className="text-warn">{t('blind.not_exclusive_offline')}</p>
        )
      ) : null}
      <div className="field">
        <label htmlFor={sourceSelectId}>{t('blind.source_label')}</label>
        <select
          id={sourceSelectId}
          className="text-input"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
        >
          <option value="">{t('blind.source_placeholder')}</option>
          {sources.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {dispatch ? (
        <p className="alert alert-error" role="alert">
          {t('blind.known_dispatch', { doc: dispatch.doc_number })}{' '}
          <Link to={ROUTES.receiveOne(dispatch.id)}>{t('blind.receive_with_document')}</Link>
        </p>
      ) : null}
      <LinesEditor
        rows={rows}
        products={products}
        onUpdate={(key, patch) =>
          setLines((current) =>
            current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
          )
        }
        onRemove={(key) => setLines((current) => current.filter((line) => line.key !== key))}
        onAdd={() => setLines((current) => [...current, newLine()])}
        lineIssue={(row) =>
          duplicates.has(row.check.draft.productId) ? t('blind.duplicate') : null
        }
      />
      {lotRequired && online ? <p className="text-warn">{t('blind.lot_required')}</p> : null}
      <div className="field">
        <label htmlFor={notesId}>{t('transfer.notes_label')}</label>
        <textarea
          id={notesId}
          className="text-input"
          rows={2}
          maxLength={MAX_TRANSFER_NOTES}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <ActionBar>
        <Button size="lg" className="submit-sale" disabled={!ready} onClick={() => void submit()}>
          {busy ? t('sales.submitting') : t('blind.submit')}
        </Button>
      </ActionBar>
    </section>
  );
}
