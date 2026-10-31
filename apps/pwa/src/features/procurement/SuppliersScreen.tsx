/**
 * ECR-APP-01 « Fournisseurs » (responsable des achats ; action `SUPPLIERS` ; en ligne). Liste lue sur
 * le serveur (tous statuts), création, modification des champs changés, désactivation et
 * réactivation (`procurement.supplier.*`, agrégat `SUPPLIER`). Relue après chaque opération ;
 * l'opération suivante attend la réponse définitive de la précédente. Cartes sur téléphone, colonnes
 * sur ordinateur.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Section,
  SkeletonRows,
} from '../../components/ui/index.js';
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
import './procurement.css';

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
    key: Exclude<keyof SupplierForm, 'suppliedCategories' | 'paymentTermsText'>,
    max: number,
    inputMode?: 'tel' | 'email',
  ) => (
    <Field label={t(`suppliers.field.${key}`)}>
      {(control) => (
        <Input
          {...control}
          maxLength={max}
          inputMode={inputMode}
          value={form[key]}
          disabled={key === 'code' && !creating}
          onChange={(event) => update({ [key]: event.target.value } as Partial<SupplierForm>)}
        />
      )}
    </Field>
  );

  return (
    <Section
      title={
        creating ? t('suppliers.new_title') : t('suppliers.edit_title', { name: supplier.name })
      }
    >
      <Card padded className="proc-form">
        <div className="proc-pair">
          {field('code', SUPPLIER_LIMITS.code)}
          {field('name', SUPPLIER_LIMITS.name)}
        </div>
        <div className="proc-pair">
          {field('contactName', SUPPLIER_LIMITS.contactName)}
          {field('phone', SUPPLIER_LIMITS.phone, 'tel')}
        </div>
        <div className="proc-pair">
          {field('email', SUPPLIER_LIMITS.email, 'email')}
          {field('taxId', SUPPLIER_LIMITS.taxId)}
        </div>
        {field('address', SUPPLIER_LIMITS.address)}
        <div className="proc-pair">
          <Field label={t('suppliers.field.paymentTermsText')}>
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                maxLength={String(MAX_PAYMENT_TERMS_DAYS).length}
                value={form.paymentTermsText}
                onChange={(event) => update({ paymentTermsText: event.target.value })}
              />
            )}
          </Field>
          {field('notes', SUPPLIER_LIMITS.notes)}
        </div>
        {!creating ? <p className="muted">{t('suppliers.edit_hint')}</p> : null}
        {refs.productCategories.length > 0 ? (
          <fieldset className="proc-checks">
            <legend>{t('suppliers.categories_label')}</legend>
            {refs.productCategories.map((category) => (
              <Checkbox
                key={category.id}
                label={category.name}
                checked={form.suppliedCategories.includes(category.code)}
                onChange={() => toggleCategory(category.code)}
              />
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
            <p key={issue} className="field-error">
              {t(`suppliers.issue.${issue}`)}
            </p>
          ))}
      </Card>
      <ActionBar>
        <Button variant="outline" onClick={onCancel}>
          {t('price_rules.cancel')}
        </Button>
        <Button
          size="lg"
          className="submit-sale"
          disabled={!ready}
          onClick={() => onSubmit(creating ? createPayload(form) : (changes ?? {}))}
        >
          {creating ? t('suppliers.create') : t('suppliers.save')}
        </Button>
      </ActionBar>
    </Section>
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
      <section className="sale proc-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.suppliers')} />
        <SkeletonRows rows={3} />
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
    <section className="sale proc-screen">
      <PageHeader
        title={t('nav.screens.suppliers')}
        actions={
          suppliers && !editing ? (
            <Button disabled={blocked} onClick={() => setEditing({ supplier: null })}>
              {t('suppliers.new')}
            </Button>
          ) : undefined
        }
      />
      {!online ? <Banner tone="bad">{t('suppliers.online_only')}</Banner> : null}
      {shownCommandId ? (
        <CommandResult commandId={shownCommandId} messages="suppliers.result" />
      ) : null}
      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
      {online && suppliers === undefined && !read.failed ? <SkeletonRows rows={3} /> : null}
      {online && read.failed ? (
        <Banner
          tone="bad"
          action={
            read.denied ? undefined : (
              <Button variant="outline" size="sm" onClick={read.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {read.denied ? t('suppliers.denied') : t('suppliers.unavailable')}
        </Banner>
      ) : null}
      {online && suppliers && read.stale && !read.failed ? (
        <p className="muted" role="status">
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
        sorted.length === 0 ? (
          <EmptyState icon="truck" title={t('suppliers.none')} />
        ) : (
          <DataList
            aria-label={t('nav.screens.suppliers')}
            columns={[
              { label: t('suppliers.col.supplier') },
              { label: t('suppliers.col.contact') },
              { label: t('suppliers.col.terms') },
              { label: t('suppliers.col.status') },
              { label: '' },
            ]}
            template="minmax(0, 2.2fr) minmax(0, 2.2fr) 9rem 7rem 13rem"
          >
            {sorted.map((supplier) => (
              <DataRow key={supplier.id} aria-label={supplier.name}>
                <DataCell primary>
                  <span className="proc-name">
                    <strong>{supplier.name}</strong>
                    <small>{supplier.code}</small>
                  </span>
                </DataCell>
                <DataCell>
                  <span className="proc-text">
                    {[supplier.contactName, supplier.phone].filter(Boolean).join(' · ')}
                  </span>
                </DataCell>
                <DataCell>
                  {supplier.paymentTermsDays !== null ? (
                    <span className="proc-text">
                      {t('suppliers.terms', { days: supplier.paymentTermsDays })}
                    </span>
                  ) : null}
                </DataCell>
                <DataCell>
                  <Badge tone={supplier.status === 'ACTIVE' ? 'ok' : 'muted'}>
                    {t(`suppliers.status.${supplier.status}`, { defaultValue: supplier.status })}
                  </Badge>
                </DataCell>
                <DataCell actions>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={blocked}
                    onClick={() => setEditing({ supplier })}
                  >
                    {t('suppliers.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
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
                  </Button>
                </DataCell>
              </DataRow>
            ))}
          </DataList>
        )
      ) : null}
    </section>
  );
}
