/**
 * Profil commercial du client sur la fiche du compte (PP-D ; REQ-308, AV-316) : le produit qui intéresse le client,
 * ce qu'il peut écouler par jour, sa façon habituelle de payer, et la demande de paiement différé du commercial —
 * distincte de la décision du responsable (`credit_allowed`). La modification part en `crm.customer.update`, qui ne
 * porte que les champs changés ; elle se voit aussitôt sur la fiche, hors ligne comme en ligne.
 *
 * Le profil de départ et la version du compte sont ceux de l'ouverture de l'édition : un compte relu du serveur
 * pendant la saisie ne fait pas écrire des champs que l'utilisateur n'a pas touchés, et la fusion champ par champ du
 * serveur compare ce qu'il a changé à la version qu'il avait sous les yeux.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Card, Checkbox, Field, Input, Select } from '../../components/ui/index.js';
import type { SalesReferences } from '../sales/references.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import { saveErrorKey, submitCommand } from '../sales/submit.js';
import type { CustomerData } from '../sales/types.js';
import { checkProfile, profileOf, profilePatch, type ProfileDraft } from './profile.js';

interface Props {
  readonly customer: CustomerData;
  readonly refs: SalesReferences;
  readonly userId: string | undefined;
  /** Rôle qui peut modifier un compte de son périmètre (`crm.customer.update`) ; le serveur revérifie. */
  readonly canEdit: boolean;
}

/** Une édition en cours : le brouillon et ce qu'il y avait sous les yeux de l'utilisateur à l'ouverture. */
interface Edit {
  readonly draft: ProfileDraft;
  readonly base: ProfileDraft;
  /** Version du compte à l'ouverture ; `null` : compte créé sur l'appareil, pas encore servi. */
  readonly baseVersion: number | null;
  /** Création du compte encore dans l'outbox : la modification attend son application. */
  readonly dependsOn: readonly string[];
}

export function CommercialProfile({ customer, refs, userId, canEdit }: Props) {
  const { t } = useTranslation();
  const saved = profileOf(customer);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  /** Message de l'échec de l'enregistrement local : lecture seule (autonomie dépassée) ou base locale. */
  const [failure, setFailure] = useState<string | null>(null);

  // Le focus suit l'édition : sur le premier champ à l'ouverture, sur le bouton « Modifier » à la fermeture
  // (le bouton qu'on vient d'activer disparaît du DOM, le focus tomberait sinon sur la page).
  const form = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const editing = edit !== null;
  useEffect(() => {
    if (editing) form.current?.querySelector<HTMLElement>('select, input')?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const products = [...refs.products].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const productName = (id: string) =>
    refs.products.find((product) => product.id === id)?.name ?? '';
  const unitName = (code: string) => refs.units.get(code)?.name ?? code;
  const methodLabel = (code: string) =>
    refs.paymentMethods.find((method) => method.code === code)?.label ?? code;

  const potential =
    saved.potentialQtyText === ''
      ? '—'
      : t('customer.profile.potential_value', {
          qty: saved.potentialQtyText,
          unit: unitName(saved.potentialUnitCode),
        });
  const creditState = customer.credit_allowed
    ? t('customer.profile.credit_allowed')
    : saved.creditRequested
      ? t('customer.profile.credit_requested')
      : t('customer.profile.credit_not_requested');

  if (edit === null) {
    return (
      <Card padded>
        <h3 className="crm-profile-title">{t('customer.profile.title')}</h3>
        <dl className="crm-details">
          <dt>{t('customer.profile.interest')}</dt>
          <dd>{saved.interestProductId === '' ? '—' : productName(saved.interestProductId)}</dd>
          <dt>{t('customer.profile.potential')}</dt>
          <dd>{potential}</dd>
          <dt>{t('customer.profile.payment')}</dt>
          <dd>
            {saved.usualPaymentMethodCode === '' ? '—' : methodLabel(saved.usualPaymentMethodCode)}
          </dd>
          <dt>{t('customer.profile.credit')}</dt>
          <dd>{creditState}</dd>
        </dl>
        {canEdit && userId ? (
          <Button
            ref={editButton}
            variant="outline"
            size="sm"
            icon="edit"
            onClick={() =>
              setEdit({
                draft: saved,
                base: saved,
                baseVersion: customer.pending_command_id ? null : customer.version,
                dependsOn: customer.pending_command_id ? [customer.pending_command_id] : [],
              })
            }
          >
            {t('customer.profile.edit')}
          </Button>
        ) : null}
      </Card>
    );
  }

  const { draft } = edit;
  const issues = checkProfile(draft);
  const patch = profilePatch(draft, edit.base);
  const product = products.find((candidate) => candidate.id === draft.interestProductId);
  // Unités proposées pour le potentiel : celles du produit d'intérêt, à défaut les unités actives du catalogue.
  const units = product
    ? saleUnitsOf(product, refs).map((unit) => unit.unitCode)
    : [...refs.units.values()].filter((unit) => unit.is_active).map((unit) => unit.code);
  const unitCodes =
    draft.potentialUnitCode && !units.includes(draft.potentialUnitCode)
      ? [draft.potentialUnitCode, ...units]
      : units;
  // Moyens actifs, plus le moyen déjà enregistré s'il a été désactivé depuis : sans cette option le champ afficherait
  // « — » tout en gardant le code, et le moyen ne pourrait plus être retiré.
  const methods = refs.paymentMethods
    .filter((method) => method.is_active)
    .map((method) => ({ code: method.code, label: method.label }));
  const methodOptions =
    draft.usualPaymentMethodCode && !methods.some((m) => m.code === draft.usualPaymentMethodCode)
      ? [
          { code: draft.usualPaymentMethodCode, label: methodLabel(draft.usualPaymentMethodCode) },
          ...methods,
        ]
      : methods;
  const update = (change: Partial<ProfileDraft>) =>
    setEdit((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...change } },
    );

  const save = async () => {
    if (!userId || issues.length > 0 || Object.keys(patch).length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      await submitCommand({
        authorUserId: userId,
        commandType: 'crm.customer.update',
        aggregateType: 'CUSTOMER',
        aggregateId: customer.id,
        baseVersion: edit.baseVersion,
        ...(edit.dependsOn.length > 0 ? { dependsOn: [...edit.dependsOn] } : {}),
        payload: { patch },
      });
      setEdit(null);
    } catch (error) {
      setFailure(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded>
      <h3 className="crm-profile-title">{t('customer.profile.title')}</h3>
      <div className="crm-inline-form" ref={form}>
        <Field label={t('customer.profile.interest')} optional>
          {(control) => (
            <Select
              {...control}
              value={draft.interestProductId}
              onChange={(event) => update({ interestProductId: event.target.value })}
            >
              <option value="">{t('customer.profile.interest_none')}</option>
              {products.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="crm-pair">
          <Field
            label={t('customer.profile.potential')}
            optional
            error={
              issues.includes('QTY_INVALID') ? t('customer.profile.issue.QTY_INVALID') : undefined
            }
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={draft.potentialQtyText}
                onChange={(event) => update({ potentialQtyText: event.target.value })}
              />
            )}
          </Field>
          <Field
            label={t('customer.profile.potential_unit')}
            optional
            error={
              issues.includes('UNIT_REQUIRED')
                ? t('customer.profile.issue.UNIT_REQUIRED')
                : undefined
            }
          >
            {(control) => (
              <Select
                {...control}
                value={draft.potentialUnitCode}
                onChange={(event) => update({ potentialUnitCode: event.target.value })}
              >
                <option value="">—</option>
                {unitCodes.map((code) => (
                  <option key={code} value={code}>
                    {unitName(code)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('customer.profile.payment')} optional>
          {(control) => (
            <Select
              {...control}
              value={draft.usualPaymentMethodCode}
              onChange={(event) => update({ usualPaymentMethodCode: event.target.value })}
            >
              <option value="">—</option>
              {methodOptions.map((method) => (
                <option key={method.code} value={method.code}>
                  {method.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {customer.credit_allowed ? (
          <p className="muted">{t('customer.profile.credit_allowed')}</p>
        ) : (
          <Checkbox
            label={t('customer.profile.credit_request')}
            hint={t('customer.profile.credit_request_hint')}
            checked={draft.creditRequested}
            onChange={(event) => update({ creditRequested: event.target.checked })}
          />
        )}
        {failure !== null ? <Banner tone="bad">{t(failure)}</Banner> : null}
        <div className="chip-row">
          <Button
            size="sm"
            loading={busy}
            disabled={issues.length > 0 || Object.keys(patch).length === 0}
            onClick={() => void save()}
          >
            {t('customer.profile.save')}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEdit(null)}>
            {t('customer.profile.cancel')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
