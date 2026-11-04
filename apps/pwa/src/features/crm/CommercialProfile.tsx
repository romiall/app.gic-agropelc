/**
 * Profil commercial du client sur la fiche du compte (PP-D ; REQ-308, AV-316) : le produit qui intéresse le client,
 * ce qu'il peut écouler par jour, sa façon habituelle de payer, et la demande de paiement différé du commercial —
 * distincte de la décision du responsable (`credit_allowed`). La modification part en `crm.customer.update`, qui ne
 * porte que les champs changés ; elle se voit aussitôt sur la fiche, hors ligne comme en ligne.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Card, Checkbox, Field, Input, Select } from '../../components/ui/index.js';
import type { SalesReferences } from '../sales/references.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import { submitCommand } from '../sales/submit.js';
import type { CustomerData } from '../sales/types.js';
import { checkProfile, profileOf, profilePatch, type ProfileDraft } from './profile.js';

interface Props {
  readonly customer: CustomerData;
  readonly refs: SalesReferences;
  readonly userId: string | undefined;
  /** Rôle qui peut modifier un compte de son périmètre (`crm.customer.update`) ; le serveur revérifie. */
  readonly canEdit: boolean;
}

export function CommercialProfile({ customer, refs, userId, canEdit }: Props) {
  const { t } = useTranslation();
  const saved = profileOf(customer);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

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

  if (draft === null) {
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
          <Button variant="outline" size="sm" icon="edit" onClick={() => setDraft(saved)}>
            {t('customer.profile.edit')}
          </Button>
        ) : null}
      </Card>
    );
  }

  const issues = checkProfile(draft);
  const patch = profilePatch(draft, saved);
  const product = products.find((candidate) => candidate.id === draft.interestProductId);
  // Unités proposées pour le potentiel : celles du produit d'intérêt, à défaut les unités actives du catalogue.
  const units = product
    ? saleUnitsOf(product, refs).map((unit) => unit.unitCode)
    : [...refs.units.values()].filter((unit) => unit.is_active).map((unit) => unit.code);
  const unitCodes =
    draft.potentialUnitCode && !units.includes(draft.potentialUnitCode)
      ? [draft.potentialUnitCode, ...units]
      : units;
  const methods = refs.paymentMethods.filter((method) => method.is_active);
  const update = (change: Partial<ProfileDraft>) =>
    setDraft((current) => (current === null ? current : { ...current, ...change }));

  const save = async () => {
    if (!userId || issues.length > 0 || Object.keys(patch).length === 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await submitCommand({
        authorUserId: userId,
        commandType: 'crm.customer.update',
        aggregateType: 'CUSTOMER',
        aggregateId: customer.id,
        // Compte créé sur l'appareil : pas encore de version servie, et la modification attend sa création.
        baseVersion: customer.pending_command_id ? null : customer.version,
        ...(customer.pending_command_id ? { dependsOn: [customer.pending_command_id] } : {}),
        payload: { patch },
      });
      setDraft(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded>
      <h3 className="crm-profile-title">{t('customer.profile.title')}</h3>
      <div className="crm-inline-form">
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
          <Field label={t('customer.profile.potential')} optional>
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={draft.potentialQtyText}
                onChange={(event) => update({ potentialQtyText: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('customer.profile.potential_unit')} optional>
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
              {methods.map((method) => (
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
        {issues.includes('QTY_INVALID') ? (
          <p className="field-error">{t('customer.profile.issue.QTY_INVALID')}</p>
        ) : null}
        {issues.includes('UNIT_REQUIRED') ? (
          <p className="field-error">{t('customer.profile.issue.UNIT_REQUIRED')}</p>
        ) : null}
        {failed ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
        <div className="chip-row">
          <Button
            size="sm"
            loading={busy}
            disabled={issues.length > 0 || Object.keys(patch).length === 0}
            onClick={() => void save()}
          >
            {t('customer.profile.save')}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
            {t('customer.profile.cancel')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
