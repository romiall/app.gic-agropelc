/**
 * ECR-PIE-01 « Reporter une pièce papier » (PP-B ; REQ-303, AV-308, AV-312, AV-078).
 *
 * Permet aux opérateurs de terrain de saisir et synchroniser une opération accomplie sur un carnet
 * à souche papier (panne de batterie, zone blanche, habitude de terrain) :
 * - Type de pièce (BV, RE, BD, RF, CC, BL, BR, BT, FP)
 * - Numéro de la pièce papier (souche) avec contrôle dynamique de continuité (AV-312)
 * - Date/heure manuscrite avec évaluation de la fenêtre d'antidatage (AV-078 : 24 h / 72 h)
 * - Justificatif photo de la souche (ADR-012, ADR-046)
 * - Envoi par l'outbox locale via les commandes métier existantes (règle 3)
 * - Registre des carnets (RC) : historique, détection des sauts et des doublons (AV-312).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Textarea,
  type SegmentedOption,
} from '../../components/ui/index.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { PhotoField } from '../attachments/PhotoField.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { useSalesReferences } from '../sales/references.js';
import { formatMoney } from '../sales/format.js';
import { PieceAction } from './PieceAction.js';
import {
  analyzeContinuity,
  checkInputContinuity,
  evaluateBackdating,
  normalizeSlipRef,
} from './registre-carnets.js';
import {
  loadReportedSlipsFromDb,
  submitPaperSlipReport,
  type ReportableSlipType,
  type ReportSlipDraft,
  type ReportedSlipRecord,
} from './report-submit.js';
import type { DemandePiece } from './demande.js';
import './pieces-report.css';

const SLIP_TYPE_OPTIONS: readonly { readonly value: ReportableSlipType; readonly label: string }[] =
  [
    { value: 'BV', label: 'BV — Bon de vente' },
    { value: 'RE', label: 'RE — Reçu d’encaissement' },
    { value: 'BD', label: 'BD — Bon de décaissement (dépense)' },
    { value: 'RF', label: 'RF — Remise de fonds' },
    { value: 'CC', label: 'CC — Bon de commande client' },
    { value: 'BL', label: 'BL — Bon de livraison' },
    { value: 'BR', label: 'BR — Bon de réception' },
    { value: 'BT', label: 'BT — Bon de transfert' },
    { value: 'FP', label: 'FP — Fiche de perte' },
  ];

function nowIsoLocal(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

type TabMode = 'entry' | 'register';

export function PaperSlipReportScreen() {
  const { t } = useTranslation();
  const { state: authState } = useAuth();
  const userId = authState.status === 'unlocked' ? authState.userId : '';
  const refs = useSalesReferences();

  const [activeTab, setActiveTab] = useState<TabMode>('entry');
  const [slipTypeFilter, setSlipTypeFilter] = useState<string>('ALL');

  // Formulaire de saisie
  const [slipType, setSlipType] = useState<ReportableSlipType>('BV');
  const [paperSlipRef, setPaperSlipRef] = useState('');
  const [occurredAt, setOccurredAt] = useState(nowIsoLocal);
  const [backdatedReason, setBackdatedReason] = useState('');
  const [siteId, setSiteId] = useState('');
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [isPhotoBusy, setIsPhotoBusy] = useState(false);

  // Spécifique BV
  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState<number>(1);
  const [unitPriceXaf, setUnitPriceXaf] = useState<number>(3000);
  const [paymentMethod, setPaymentMethod] = useState<
    'CASH' | 'MOMO' | 'OM' | 'BANK_TRANSFER' | 'CREDIT'
  >('CASH');
  const cashAccountId = '';

  // Spécifique RE
  const [reAmountXaf, setReAmountXaf] = useState<number>(0);
  const [reNotes, setReNotes] = useState('');

  // Spécifique BD
  const [bdPayeeName, setBdPayeeName] = useState('');
  const [bdAmountXaf, setBdAmountXaf] = useState<number>(0);
  const [bdDescription, setBdDescription] = useState('');

  // Spécifique RF
  const [rfSourceAccountId, setRfSourceAccountId] = useState('');
  const rfDestinationAccountId = '';
  const [rfAmountXaf, setRfAmountXaf] = useState<number>(0);

  // État de soumission
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmittedRef, setLastSubmittedRef] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pièces déjà enregistrées sur cet appareil (Dexie LiveQuery)
  const reportedSlips = useLiveQuery(async () => loadReportedSlipsFromDb(getDb()), []) ?? [];

  // Références existantes pour le type sélectionné
  const existingRefsForType = reportedSlips
    .filter((s) => s.slipType === slipType)
    .map((s) => s.paperSlipRef);

  // Évaluation de la continuité en direct sur le champ de saisie
  const continuityCheck = checkInputContinuity(paperSlipRef, existingRefsForType);

  // Évaluation de l'antidatage en direct
  const backdatingEval = evaluateBackdating(
    occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
  );

  // Analyse globale pour le registre des carnets
  const filteredSlips =
    slipTypeFilter === 'ALL'
      ? reportedSlips
      : reportedSlips.filter((s) => s.slipType === slipTypeFilter);

  const continuityReport = analyzeContinuity(filteredSlips.map((s) => s.paperSlipRef));

  const tabOptions: readonly SegmentedOption<TabMode>[] = [
    { value: 'entry', label: t('piece.report_tab_entry', 'Saisie du report') },
    { value: 'register', label: t('piece.report_tab_register', 'Registre des carnets (RC)') },
  ];

  const resetForm = () => {
    setPaperSlipRef('');
    setOccurredAt(nowIsoLocal());
    setBackdatedReason('');
    setPhoto(null);
    setReAmountXaf(0);
    setReNotes('');
    setBdPayeeName('');
    setBdAmountXaf(0);
    setBdDescription('');
    setRfAmountXaf(0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paperSlipRef.trim() || submitting || isPhotoBusy || !userId) return;

    if (backdatingEval.isFuture) {
      setSubmitError(
        t('piece.future_date_error', 'La date de la pièce ne peut pas être dans le futur.'),
      );
      return;
    }

    if (backdatingEval.requiresReason && !backdatedReason.trim()) {
      setSubmitError(
        t(
          'piece.backdated_reason_hint',
          'Un motif est requis car la pièce date de plus de 24 h (AV-078).',
        ),
      );
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    const draft: ReportSlipDraft = {
      slipType,
      paperSlipRef: normalizeSlipRef(paperSlipRef),
      occurredAt,
      backdatedReason,
      siteId: siteId || undefined,
      customerId: customerId || undefined,
      productId: productId || undefined,
      quantity,
      unitPriceXaf,
      totalAmountXaf: quantity * unitPriceXaf,
      paymentMethod,
      cashAccountId: cashAccountId || undefined,
      reAmountXaf,
      rePaymentMethod: paymentMethod === 'CREDIT' ? 'CASH' : paymentMethod,
      reNotes,
      bdPayeeName,
      bdAmountXaf,
      bdDescription,
      rfSourceAccountId: rfSourceAccountId || undefined,
      rfDestinationAccountId: rfDestinationAccountId || undefined,
      rfAmountXaf,
    };

    try {
      await submitPaperSlipReport(draft, userId, photo);
      setLastSubmittedRef(draft.paperSlipRef);
      resetForm();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Erreur lors de l’enregistrement');
    } finally {
      setSubmitting(false);
    }
  };

  /** Prépare une demande d'impression / aperçu de pièce papier pour un enregistrement de l'historique */
  const preparePieceForRecord = (record: ReportedSlipRecord): DemandePiece | null => {
    if (record.slipType === 'BV') {
      return {
        code: 'BV',
        donnees: {
          numero: record.paperSlipRef,
          client: 'Client sur pièce',
          telephone: null,
          anonyme: false,
          pointDeVente: null,
          dateHeure: record.occurredAt,
          vendeur: 'Opérateur terrain',
          lignes: [
            {
              designation: record.description,
              unite: 'U',
              quantite: '1',
              prixUnitaire: record.amountXaf ?? 0,
              remise: 0,
              montant: record.amountXaf ?? 0,
            },
          ],
          total: record.amountXaf ?? 0,
          moyens: ['Espèces'],
          encaisse: record.amountXaf ?? 0,
          reference: null,
          resteDu: 0,
        },
      };
    }
    if (record.slipType === 'RE') {
      return {
        code: 'RE',
        donnees: {
          numero: record.paperSlipRef,
          recuDe: 'Client sur pièce',
          telephone: null,
          site: null,
          dateHeure: record.occurredAt,
          montant: record.amountXaf ?? 0,
          resteDu: 0,
          moyen: 'Espèces',
          reference: null,
          objet: null,
          objetNumero: record.description,
          caissier: 'Opérateur terrain',
        },
      };
    }
    if (record.slipType === 'BD') {
      return {
        code: 'BD',
        donnees: {
          numero: record.paperSlipRef,
          beneficiaire: record.description,
          pieceIdentite: null,
          caisse: 'Caisse terrain',
          dateHeure: record.occurredAt,
          etabliPar: 'Opérateur terrain',
          nature: 'dépense',
          categorie: null,
          objet: record.description,
          imputeA: null,
          factureOuBc: null,
          montant: record.amountXaf ?? 0,
          justificatifs: [],
          autorisePar: 'Responsable',
        },
      };
    }
    return null;
  };

  return (
    <div className="report-screen">
      <PageHeader
        title={t('piece.report_title', 'Reporter une pièce papier')}
        subtitle={t(
          'piece.report_subtitle',
          'Saisie des pièces de carnets à souche et registre (AV-308, AV-312)',
        )}
      />

      <div className="report-tabs">
        <Segmented<TabMode>
          label={t('piece.tabs_label', 'Mode d’affichage')}
          options={tabOptions}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {activeTab === 'entry' ? (
        <form onSubmit={handleSubmit} className="report-form">
          {lastSubmittedRef ? (
            <Banner tone="ok">
              {t('piece.report_success', {
                ref: lastSubmittedRef,
                defaultValue: `Pièce ${lastSubmittedRef} enregistrée dans la file d’attente locale (outbox).`,
              })}
            </Banner>
          ) : null}

          {submitError ? <Banner tone="bad">{submitError}</Banner> : null}

          <Card title={t('piece.section_general', 'Informations du carnet papier')}>
            <div className="report-grid-2">
              <Field label={t('piece.slip_type', 'Type de pièce')}>
                {(ctrl) => (
                  <Select
                    {...ctrl}
                    value={slipType}
                    onChange={(e) => setSlipType(e.target.value as ReportableSlipType)}
                  >
                    {SLIP_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field
                label={t('piece.slip_ref', 'Numéro de la pièce (souche)')}
                hint={t('piece.slip_ref_hint', 'Ex. BV-000142, RE-0045, BD-012…')}
              >
                {(ctrl) => (
                  <Input
                    {...ctrl}
                    value={paperSlipRef}
                    onChange={(e) => setPaperSlipRef(e.target.value)}
                    placeholder="Ex. 000142"
                    required
                  />
                )}
              </Field>
            </div>

            {/* Avertissements de continuité en temps réel (AV-312) */}
            {continuityCheck.isDuplicate ? (
              <div className="report-continuity-alert">
                <Banner tone="warn">
                  {t(
                    'piece.duplicate_warning',
                    'Numéro déjà saisi : cette référence existe déjà sur cet appareil. Le doublon sera signalé sans être rejeté (BR-SYN-007).',
                  )}
                </Banner>
              </div>
            ) : null}

            {continuityCheck.isGap ? (
              <div className="report-continuity-alert">
                <Banner tone="info">
                  {t('piece.gap_warning', {
                    last: continuityCheck.lastMaxNumber,
                    missing: continuityCheck.missingBefore.join(', '),
                    defaultValue: `Saut détecté : la dernière pièce enregistrée était le n° ${continuityCheck.lastMaxNumber}. Pièces manquantes : ${continuityCheck.missingBefore.join(', ')}.`,
                  })}
                </Banner>
              </div>
            ) : null}

            <div className="report-grid-2" style={{ marginTop: 'var(--space-3)' }}>
              <Field label={t('piece.occurred_at', 'Date et heure manuscrite de la pièce')}>
                {(ctrl) => (
                  <Input
                    {...ctrl}
                    type="datetime-local"
                    value={occurredAt}
                    onChange={(e) => setOccurredAt(e.target.value)}
                    required
                  />
                )}
              </Field>

              {refs?.sites && refs.sites.size > 0 ? (
                <Field label={t('common.site', 'Site')}>
                  {(ctrl) => (
                    <Select {...ctrl} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                      <option value="">{t('common.choose_site', 'Choisir un site…')}</option>
                      {Array.from(refs.sites.values()).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
            </div>

            {/* Évaluation de la fenêtre d'antidatage (AV-078) */}
            {backdatingEval.isCriticalDelay ? (
              <div className="report-continuity-alert">
                <Banner tone="warn">
                  {t(
                    'piece.critical_delay_warning',
                    'Attention : le délai de report dépasse 72 h (AV-078). Cette pièce fera l’objet d’une vérification comptable a posteriori.',
                  )}
                </Banner>
              </div>
            ) : null}

            {backdatingEval.requiresReason ? (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <Field
                  label={t('piece.backdated_reason', 'Motif de report / antidatage')}
                  hint={t(
                    'piece.backdated_reason_hint',
                    'Requis car la pièce a été signée il y a plus de 24 h (AV-078).',
                  )}
                >
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      value={backdatedReason}
                      onChange={(e) => setBackdatedReason(e.target.value)}
                      placeholder="Ex. Retour de tournée terrain, carnet transmis le..."
                      required
                    />
                  )}
                </Field>
              </div>
            ) : null}
          </Card>

          {/* Formulaires contextuels selon la pièce */}
          {slipType === 'BV' ? (
            <Card title={t('piece.section_bv', 'Détails du Bon de Vente (BV)')}>
              <div className="report-grid-2">
                {refs?.customers && refs.customers.length > 0 ? (
                  <Field label={t('sales.customer', 'Client')}>
                    {(ctrl) => (
                      <Select
                        {...ctrl}
                        value={customerId}
                        onChange={(e) => setCustomerId(e.target.value)}
                      >
                        <option value="">
                          {t('sales.anonymous_customer', 'Client comptoir / non listé')}
                        </option>
                        {refs.customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.display_name} {c.phone_primary ? `(${c.phone_primary})` : ''}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}

                {refs?.products && refs.products.length > 0 ? (
                  <Field label={t('sales.product', 'Produit')}>
                    {(ctrl) => (
                      <Select
                        {...ctrl}
                        value={productId}
                        onChange={(e) => setProductId(e.target.value)}
                      >
                        <option value="">{t('sales.choose_product', 'Choisir un produit…')}</option>
                        {refs.products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
              </div>

              <div className="report-grid-2" style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('sales.quantity', 'Quantité')}>
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      type="number"
                      min="1"
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    />
                  )}
                </Field>

                <Field label={t('sales.unit_price', 'Prix unitaire (XAF)')}>
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      type="number"
                      min="0"
                      step="50"
                      value={unitPriceXaf}
                      onChange={(e) =>
                        setUnitPriceXaf(Math.max(0, parseInt(e.target.value, 10) || 0))
                      }
                    />
                  )}
                </Field>
              </div>

              <div className="report-grid-2" style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('sales.payment_method', 'Règlement')}>
                  {(ctrl) => (
                    <Select
                      {...ctrl}
                      value={paymentMethod}
                      onChange={(e) =>
                        setPaymentMethod(
                          e.target.value as 'CASH' | 'MOMO' | 'OM' | 'BANK_TRANSFER' | 'CREDIT',
                        )
                      }
                    >
                      <option value="CASH">Espèces</option>
                      <option value="MOMO">MTN Mobile Money</option>
                      <option value="OM">Orange Money</option>
                      <option value="BANK_TRANSFER">Virement bancaire</option>
                      <option value="CREDIT">À crédit / différé</option>
                    </Select>
                  )}
                </Field>

                <div style={{ display: 'flex', alignItems: 'center', fontWeight: 'bold' }}>
                  <span>Total : {formatMoney(quantity * unitPriceXaf)}</span>
                </div>
              </div>
            </Card>
          ) : null}

          {slipType === 'RE' ? (
            <Card title={t('piece.section_re', 'Détails du Reçu d’encaissement (RE)')}>
              <div className="report-grid-2">
                <Field label={t('sales.amount', 'Montant encaissé (XAF)')}>
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      type="number"
                      min="0"
                      value={reAmountXaf}
                      onChange={(e) =>
                        setReAmountXaf(Math.max(0, parseInt(e.target.value, 10) || 0))
                      }
                      required
                    />
                  )}
                </Field>

                <Field label={t('sales.payment_method', 'Mode de règlement')}>
                  {(ctrl) => (
                    <Select
                      {...ctrl}
                      value={paymentMethod}
                      onChange={(e) =>
                        setPaymentMethod(
                          e.target.value as 'CASH' | 'MOMO' | 'OM' | 'BANK_TRANSFER' | 'CREDIT',
                        )
                      }
                    >
                      <option value="CASH">Espèces</option>
                      <option value="MOMO">MTN Mobile Money</option>
                      <option value="OM">Orange Money</option>
                      <option value="BANK_TRANSFER">Virement</option>
                    </Select>
                  )}
                </Field>
              </div>

              <div style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('common.notes', 'Motif / Notes de l’encaissement')}>
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      value={reNotes}
                      onChange={(e) => setReNotes(e.target.value)}
                      placeholder="Ex. Règlement partiel solde facture..."
                    />
                  )}
                </Field>
              </div>
            </Card>
          ) : null}

          {slipType === 'BD' ? (
            <Card title={t('piece.section_bd', 'Détails du Bon de décaissement (BD)')}>
              <div className="report-grid-2">
                <Field label={t('finance.payee', 'Bénéficiaire')}>
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      value={bdPayeeName}
                      onChange={(e) => setBdPayeeName(e.target.value)}
                      placeholder="Nom du fournisseur ou bénéficiaire"
                      required
                    />
                  )}
                </Field>

                <Field label={t('finance.amount', 'Montant décaissé (XAF)')}>
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      type="number"
                      min="0"
                      value={bdAmountXaf}
                      onChange={(e) =>
                        setBdAmountXaf(Math.max(0, parseInt(e.target.value, 10) || 0))
                      }
                      required
                    />
                  )}
                </Field>
              </div>

              <div style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('finance.description', 'Description / Motif de la dépense')}>
                  {(ctrl) => (
                    <Textarea
                      {...ctrl}
                      value={bdDescription}
                      onChange={(e) => setBdDescription(e.target.value)}
                      placeholder="Objet de la dépense sur le bon papier..."
                      rows={2}
                      required
                    />
                  )}
                </Field>
              </div>
            </Card>
          ) : null}

          {slipType === 'RF' ? (
            <Card title={t('piece.section_rf', 'Détails de la Remise de fonds (RF)')}>
              <div className="report-grid-2">
                <Field label={t('finance.amount', 'Montant remis (XAF)')}>
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      type="number"
                      min="0"
                      value={rfAmountXaf}
                      onChange={(e) =>
                        setRfAmountXaf(Math.max(0, parseInt(e.target.value, 10) || 0))
                      }
                      required
                    />
                  )}
                </Field>

                {refs?.cashAccounts && refs.cashAccounts.length > 0 ? (
                  <Field label={t('finance.cash_account', 'Caisse source')}>
                    {(ctrl) => (
                      <Select
                        {...ctrl}
                        value={rfSourceAccountId}
                        onChange={(e) => setRfSourceAccountId(e.target.value)}
                      >
                        <option value="">
                          {t('finance.choose_account', 'Choisir la caisse source…')}
                        </option>
                        {refs.cashAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
              </div>
            </Card>
          ) : null}

          {/* Justificatif photo de la souche papier (MP-10, ADR-012) */}
          <Card title={t('piece.section_photo', 'Photo de la pièce papier (souche)')}>
            <PhotoField
              label={t('piece.photo_label', 'Preuve photo de la souche')}
              hint={t(
                'piece.photo_hint',
                'Recommandé : prenez en photo la souche ou le feuillet du carnet comme justificatif.',
              )}
              value={photo}
              onChange={setPhoto}
              onBusyChange={setIsPhotoBusy}
            />
          </Card>

          {/* Un seul bouton principal plein par écran (règle refonte) */}
          <ActionBar>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || isPhotoBusy || !paperSlipRef.trim()}
            >
              {submitting
                ? t('common.saving', 'Enregistrement…')
                : t('piece.submit_report', 'Enregistrer le report')}
            </Button>
          </ActionBar>
        </form>
      ) : (
        /* Onglet 2 : Registre des carnets (AV-312) */
        <div className="report-section">
          <div className="report-filter-bar">
            <span>{t('piece.filter_by_type', 'Filtrer par type :')}</span>
            <Select value={slipTypeFilter} onChange={(e) => setSlipTypeFilter(e.target.value)}>
              <option value="ALL">Tous les carnets</option>
              {SLIP_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="report-kpis">
            <Card>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                {t('piece.total_slips', 'Total reporté')}
              </div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 'bold' }}>
                {continuityReport.totalCount}
              </div>
            </Card>

            <Card>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                {t('piece.range', 'Plage (Min - Max)')}
              </div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'bold' }}>
                {continuityReport.minNumber !== null && continuityReport.maxNumber !== null
                  ? `N° ${continuityReport.minNumber} → ${continuityReport.maxNumber}`
                  : '—'}
              </div>
            </Card>

            <Card>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                {t('piece.gaps_detected', 'Sauts détectés')}
              </div>
              <div
                style={{
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 'bold',
                  color: continuityReport.missingNumbers.length > 0 ? 'var(--warning)' : undefined,
                }}
              >
                {continuityReport.missingNumbers.length}
              </div>
            </Card>

            <Card>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                {t('piece.duplicates_detected', 'Doublons détectés')}
              </div>
              <div
                style={{
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 'bold',
                  color: continuityReport.duplicates.length > 0 ? 'var(--bad)' : undefined,
                }}
              >
                {continuityReport.duplicates.length}
              </div>
            </Card>
          </div>

          {continuityReport.duplicates.length > 0 ? (
            <Banner tone="warn">
              {t('piece.duplicates_summary', {
                refs: continuityReport.duplicates.map((d) => `${d.ref} (${d.count}x)`).join(', '),
                defaultValue: `Doublons détectés : ${continuityReport.duplicates.map((d) => `${d.ref} (${d.count}x)`).join(', ')}.`,
              })}
            </Banner>
          ) : null}

          {continuityReport.missingNumbers.length > 0 ? (
            <Banner tone="info">
              {t('piece.gaps_summary', {
                gaps:
                  continuityReport.missingNumbers.slice(0, 15).join(', ') +
                  (continuityReport.missingNumbers.length > 15 ? '…' : ''),
                defaultValue: `Numéros manquants dans la suite : ${continuityReport.missingNumbers.slice(0, 15).join(', ')}${continuityReport.missingNumbers.length > 15 ? '…' : ''}.`,
              })}
            </Banner>
          ) : null}

          {filteredSlips.length === 0 ? (
            <p
              style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-6)' }}
            >
              {t('piece.no_slips', 'Aucune pièce papier enregistrée pour ce filtre.')}
            </p>
          ) : (
            <div className="report-slips-list">
              {filteredSlips.map((slip) => (
                <Card key={slip.commandId} className="report-slip-card">
                  <div className="report-slip-card-header">
                    <div>
                      <Badge tone="muted">{slip.slipType}</Badge>{' '}
                      <span className="report-slip-ref">{slip.paperSlipRef}</span>
                    </div>
                    <Badge
                      tone={
                        slip.status === 'SYNCED'
                          ? 'ok'
                          : slip.status === 'CONFLICT'
                            ? 'warn'
                            : 'muted'
                      }
                    >
                      {slip.status}
                    </Badge>
                  </div>

                  <div className="report-slip-meta">
                    <span>
                      Date sur pièce : {new Date(slip.occurredAt).toLocaleString('fr-FR')}
                    </span>
                    {slip.amountXaf !== null && slip.amountXaf !== undefined ? (
                      <span style={{ fontWeight: 600 }}>{formatMoney(slip.amountXaf)}</span>
                    ) : null}
                  </div>

                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text)' }}>
                    {slip.description}
                  </div>

                  {slip.backdatedReason ? (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      Motif : {slip.backdatedReason}
                    </div>
                  ) : null}

                  {/* Possibilité de voir/imprimer la pièce remplie */}
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <PieceAction
                      demande={() => preparePieceForRecord(slip)}
                      cle={`slip-${slip.commandId}`}
                      libelle={t('piece.show_slip', 'Aperçu de la pièce')}
                    />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
