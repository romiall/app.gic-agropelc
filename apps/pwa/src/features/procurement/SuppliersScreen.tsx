/**
 * ECR-APP-01 « Fournisseurs » (responsable des achats ; action `SUPPLIERS` ; en ligne). Liste lue sur
 * le serveur (tous statuts), création, modification des champs changés, désactivation et
 * réactivation (`procurement.supplier.*`, agrégat `SUPPLIER`). Relue après chaque opération ;
 * l'opération suivante attend la réponse définitive de la précédente.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
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
import {
  checkSupplier,
  createPayload,
  EMPTY_SUPPLIER,
  formOf,
  MAX_PAYMENT_TERMS_DAYS,
  pendingSupplierCodes,
  SUPPLIER_LIMITS,
  updatePayload,
  type SupplierForm,
  type SupplierView,
} from './suppliers.js';

interface EditorProps {
  readonly refs: SalesReferences;
  readonly supplier: SupplierView | null;
  readonly takenCodes: ReadonlySet<string>;
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (payload: Record<string, unknown>) => void;
}

function SupplierEditor({ refs, supplier, takenCodes, blocked, onCancel, onSubmit }: EditorProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<SupplierForm>(() =>
    supplier ? formOf(supplier) : EMPTY_SUPPLIER,
  );
  const ids = {
    code: useId(),
    name: useId(),
    contact: useId(),
    phone: useId(),
    email: useId(),
    address: useId(),
    tax: useId(),
    terms: useId(),
    notes: useId(),
  };
  const creating = supplier === null;
  const issues = checkSupplier(form, { creating, takenCodes });
  const changes = supplier ? updatePayload(supplier, form) : null;
  const ready =
    issues.length === 0 && !blocked && (changes === null || Object.keys(changes).length > 0);
  const update = (patch: Partial<SupplierForm>) => setForm((current) => ({ ...current, ...patch }));
  const toggleCategory = (code: string) =>
    update({
      suppliedCategories: form.suppliedCategories.includes(code)
        ? form.suppliedCategories.filter((candidate) => candidate !== code)
        : [...form.suppliedCategories, code],
    });
  const field = (
    id: string,
    key: Exclude<keyof SupplierForm, 'suppliedCategories' | 'paymentTermsText'>,
    max: number,
    inputMode?: 'tel' | 'email',
  ) => (
    <div className="field">
      <label htmlFor={id}>{t(`suppliers.field.${key}`)}</label>
      <input
        id={id}
        className="text-input"
        maxLength={max}
        inputMode={inputMode}
        value={form[key]}
        disabled={key === 'code' && !creating}
        onChange={(event) => update({ [key]: event.target.value } as Partial<SupplierForm>)}
      />
    </div>
  );

  return (
    <section className="sale-block" aria-labelledby="supplier-editor-title">
      <h2 id="supplier-editor-title">
        {creating ? t('suppliers.new_title') : t('suppliers.edit_title', { name: supplier.name })}
      </h2>
      {field(ids.code, 'code', SUPPLIER_LIMITS.code)}
      {field(ids.name, 'name', SUPPLIER_LIMITS.name)}
      {field(ids.contact, 'contactName', SUPPLIER_LIMITS.contactName)}
      {field(ids.phone, 'phone', SUPPLIER_LIMITS.phone, 'tel')}
      {field(ids.email, 'email', SUPPLIER_LIMITS.email, 'email')}
      {field(ids.address, 'address', SUPPLIER_LIMITS.address)}
      {field(ids.tax, 'taxId', SUPPLIER_LIMITS.taxId)}
      <div className="field">
        <label htmlFor={ids.terms}>{t('suppliers.field.paymentTermsText')}</label>
        <input
          id={ids.terms}
          className="text-input"
          inputMode="numeric"
          maxLength={String(MAX_PAYMENT_TERMS_DAYS).length}
          value={form.paymentTermsText}
          onChange={(event) => update({ paymentTermsText: event.target.value })}
        />
      </div>
      {field(ids.notes, 'notes', SUPPLIER_LIMITS.notes)}
      {!creating ? <p className="home-muted">{t('suppliers.edit_hint')}</p> : null}
      {refs.productCategories.length > 0 ? (
        <fieldset className="choice-group">
          <legend>{t('suppliers.categories_label')}</legend>
          {refs.productCategories.map((category) => (
            <label key={category.id} className="choice">
              <input
                type="checkbox"
                checked={form.suppliedCategories.includes(category.code)}
                onChange={() => toggleCategory(category.code)}
              />
              {category.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      {issues
        .filter(
          (issue) =>
            !(issue === 'CODE_REQUIRED' && !form.code) &&
            !(issue === 'NAME_REQUIRED' && !form.name),
        )
        .map((issue) => (
          <p key={issue} className="error-message">
            {t(`suppliers.issue.${issue}`)}
          </p>
        ))}
      <div className="result-actions">
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!ready}
          onClick={() => onSubmit(creating ? createPayload(form) : (changes ?? {}))}
        >
          {creating ? t('suppliers.create') : t('suppliers.save')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </section>
  );
}

export function SuppliersScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [editing, setEditing] = useState<{ supplier: SupplierView | null } | null>(null);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const lastCommand = refs?.outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(refs?.outbox ?? [], 'procurement.supplier.', userId);
  // Liste gardée pendant une relecture ou une coupure (saisie conservée), mais périmée : actions
  // bloquées jusqu'à la relecture qui suit la dernière opération.
  const read = useOnlineRead<{ suppliers?: SupplierView[] }>(
    '/api/v1/suppliers',
    readPath,
    online,
    `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(refs?.outbox ?? [], 'procurement.supplier.', userId)}`,
  );
  const suppliers = read.data ? (read.data.suppliers ?? []) : undefined;

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.suppliers')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const waiting =
    (last !== undefined &&
      (lastCommand === undefined || isBlockingWait(lastCommand, refs.outbox))) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || !online || read.stale;
  // Retour sur l'écran : la dernière opération encore en attente redevient « la dernière », pour que
  // son résultat (refus compris) reste affiché jusqu'à la réponse.
  const adopt = last ? undefined : lastWaitingCommand(refs.outbox, 'procurement.supplier.', userId);
  if (adopt) setLast(adopt.command_id);
  const shownCommandId = last;
  // Codes pris : liste lue et créations de l'appareil non refusées (un doublon lèverait une
  // exception en base, S-30).
  const takenCodes = new Set([
    ...(suppliers ?? []).map((supplier) => supplier.code),
    ...pendingSupplierCodes(refs.outbox),
  ]);
  const sorted = [...(suppliers ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  const send = async (input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast(command.command_id);
      setEditing(null);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.suppliers')}</h1>
      {!online ? (
        <p className="alert alert-error" role="alert">
          {t('suppliers.online_only')}
        </p>
      ) : null}
      {shownCommandId ? (
        <CommandResult commandId={shownCommandId} messages="suppliers.result" />
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      {online && suppliers === undefined && !read.failed ? (
        <p className="home-muted">{t('sales.loading')}</p>
      ) : null}
      {online && read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{read.denied ? t('suppliers.denied') : t('suppliers.unavailable')}</p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('ledger.retry')}
            </button>
          )}
        </div>
      ) : null}
      {online && suppliers && read.stale && !read.failed ? (
        <p className="home-muted" role="status">
          {t('suppliers.refreshing')}
        </p>
      ) : null}
      {suppliers && editing ? (
        <SupplierEditor
          refs={refs}
          supplier={editing.supplier}
          takenCodes={takenCodes}
          blocked={blocked}
          onCancel={() => setEditing(null)}
          onSubmit={(payload) =>
            void send(
              editing.supplier
                ? {
                    authorUserId: userId,
                    commandType: 'procurement.supplier.update',
                    aggregateType: 'SUPPLIER',
                    aggregateId: editing.supplier.id,
                    payload,
                  }
                : {
                    authorUserId: userId,
                    commandType: 'procurement.supplier.create',
                    aggregateType: 'SUPPLIER',
                    payload,
                  },
            )
          }
        />
      ) : null}
      {suppliers && !editing ? (
        <>
          <button
            type="button"
            className="btn-block"
            disabled={blocked}
            onClick={() => setEditing({ supplier: null })}
          >
            {t('suppliers.new')}
          </button>
          {sorted.length === 0 ? (
            <p className="home-muted">{t('suppliers.none')}</p>
          ) : (
            <ul className="line-list">
              {sorted.map((supplier) => (
                <li key={supplier.id} className="line-card" aria-label={supplier.name}>
                  <div className="line-head">
                    <strong>{supplier.name}</strong>
                    <span
                      className={`badge ${supplier.status === 'ACTIVE' ? 'badge-ok' : 'badge-muted'}`}
                    >
                      {t(`suppliers.status.${supplier.status}`, { defaultValue: supplier.status })}
                    </span>
                  </div>
                  <p className="home-muted">
                    {[
                      supplier.code,
                      supplier.contactName,
                      supplier.phone,
                      supplier.paymentTermsDays !== null
                        ? t('suppliers.terms', { days: supplier.paymentTermsDays })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <div className="result-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={blocked}
                      onClick={() => setEditing({ supplier })}
                    >
                      {t('suppliers.edit')}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={blocked}
                      onClick={() =>
                        void send({
                          authorUserId: userId,
                          commandType:
                            supplier.status === 'ACTIVE'
                              ? 'procurement.supplier.deactivate'
                              : 'procurement.supplier.reactivate',
                          aggregateType: 'SUPPLIER',
                          aggregateId: supplier.id,
                          payload: {},
                        })
                      }
                    >
                      {supplier.status === 'ACTIVE'
                        ? t('suppliers.deactivate')
                        : t('suppliers.reactivate')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
