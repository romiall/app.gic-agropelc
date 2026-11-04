/**
 * ECR-PIE-01 « Reporter une pièce papier » (PP-B ; REQ-303, AV-308, AV-312, AV-078, AV-501 à AV-504).
 *
 * Permet aux opérateurs de terrain de reporter une opération accomplie sur un carnet à souche papier
 * (panne de batterie, zone blanche, habitude de terrain) :
 * - Type de pièce (BV, RE, BD, RF, CC, BL, BR, BT, FP) et champs exigés par la commande du serveur
 *   correspondante (`report-commands.ts`) : emplacements, comptes, produits, clients… choisis dans les
 *   référentiels de l'appareil ;
 * - Numéro de la pièce papier (souche) avec contrôle dynamique de continuité (AV-312) ;
 * - Date/heure manuscrite avec évaluation de la fenêtre d'antidatage (AV-078 : 24 h / 72 h) ;
 * - Justificatif photo de la souche, quand le serveur sait le rattacher à l'opération (ADR-012, ADR-046) ;
 * - Envoi par l'outbox locale via les commandes métier existantes (règle 3), « saisies hors ligne »
 *   puisque l'opération a eu lieu hors du système (AV-502) ;
 * - Registre des carnets (RC) : historique, détection des sauts et des doublons (AV-312).
 */

import { useMemo, useState } from 'react';
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
  Section,
  Segmented,
  Select,
  type BadgeTone,
  type SegmentedOption,
} from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { PhotoField } from '../attachments/PhotoField.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { useSalesReferences } from '../sales/references.js';
import { formatDateTime } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { saveErrorKey } from '../sales/submit.js';
import { PieceAction } from './PieceAction.js';
import {
  analyzeContinuityByType,
  checkInputContinuity,
  evaluateBackdating,
} from './registre-carnets.js';
import {
  REPORTABLE_SLIP_TYPES,
  slipPhotoTarget,
  type ReportableSlipType,
} from './report-commands.js';
import {
  SLIP_ISSUE_MESSAGES,
  emptySlipForm,
  resolveSlip,
  type SlipContext,
  type SlipForm,
} from './report-form.js';
import {
  loadReportedSlipsFromDb,
  submitPaperSlipReport,
  type PayloadLabels,
  type ReportedSlipRecord,
} from './report-submit.js';
import { blankLine } from './report-lines.js';
import { SlipFields } from './ReportSections.js';
import type { DemandePiece } from './demande.js';
import './pieces-report.css';

const SLIP_TYPE_LABELS: Readonly<Record<ReportableSlipType, string>> = {
  BV: 'BV — Bon de vente',
  RE: 'RE — Reçu d’encaissement',
  BD: 'BD — Bon de décaissement (dépense)',
  RF: 'RF — Remise de fonds',
  CC: 'CC — Bon de commande client',
  BL: 'BL — Bon de livraison',
  BR: 'BR — Bon de réception',
  BT: 'BT — Bon de transfert',
  FP: 'FP — Fiche de perte',
};

/** Ton du badge d'une pièce reportée selon l'état de son envoi (les autres états restent neutres). */
const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  SYNCED: 'ok',
  SYNCED_WITH_WARNING: 'warn',
  CONFLICT: 'warn',
  REJECTED: 'bad',
};

/** Types dont le formulaire part d'une ligne vide (produit à choisir). */
const LINE_TYPES: ReadonlySet<ReportableSlipType> = new Set(['BV', 'CC', 'BR', 'BT', 'FP']);

const initialForm = (type: ReportableSlipType): SlipForm => ({
  ...emptySlipForm(clock.now(), type),
  lines: LINE_TYPES.has(type) ? [blankLine()] : [],
});

type TabMode = 'entry' | 'register';

export function PaperSlipReportScreen() {
  const { t } = useTranslation();
  const { state: authState } = useAuth();
  const userId = authState.status === 'unlocked' ? authState.userId : '';
  const refs = useSalesReferences();
  const navigation = useRememberedNavigation(userId || undefined);

  const [activeTab, setActiveTab] = useState<TabMode>('entry');
  const [slipTypeFilter, setSlipTypeFilter] = useState<string>('ALL');
  const [form, setForm] = useState<SlipForm>(() => initialForm('BV'));
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [isPhotoBusy, setIsPhotoBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmittedRef, setLastSubmittedRef] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);

  const patch = (change: Partial<SlipForm>) => setForm((current) => ({ ...current, ...change }));

  // Libellés lisibles des codes que portent les commandes (moyen de paiement du référentiel de l'appareil, nature de
  // perte en français) : le registre ne montre jamais un code brut.
  const payloadLabels = useMemo<PayloadLabels>(
    () => ({
      paymentMethod: (code) =>
        refs?.paymentMethods.find((method) => method.code === code)?.label ?? code,
      lossCategory: (code) => t(`loss.categories.${code}`, { defaultValue: code }),
    }),
    [refs, t],
  );

  // Pièces déjà enregistrées sur cet appareil (Dexie LiveQuery)
  const reportedSlips =
    useLiveQuery(async () => loadReportedSlipsFromDb(getDb(), payloadLabels), [payloadLabels]) ??
    [];

  // Références existantes pour le type sélectionné
  const existingRefsForType = reportedSlips
    .filter((s) => s.slipType === form.slipType)
    .map((s) => s.paperSlipRef);

  // Évaluation de la continuité en direct sur le champ de saisie
  const continuityCheck = checkInputContinuity(form.paperRef, existingRefsForType);

  // Évaluation de l'antidatage en direct
  const occurredDate = new Date(form.occurredAt);
  const backdatingEval = evaluateBackdating(
    Number.isNaN(occurredDate.getTime()) ? clock.now().toISOString() : occurredDate.toISOString(),
    clock.now(),
  );

  // Analyse globale pour le registre des carnets
  const filteredSlips =
    slipTypeFilter === 'ALL'
      ? reportedSlips
      : reportedSlips.filter((s) => s.slipType === slipTypeFilter);

  // Une suite de numéros par type de pièce : les carnets ne se comptent jamais ensemble (AV-312).
  const continuity = analyzeContinuityByType(filteredSlips);

  const tabOptions: readonly SegmentedOption<TabMode>[] = [
    { value: 'entry', label: t('piece.report_tab_entry', 'Saisie du report') },
    { value: 'register', label: t('piece.report_tab_register', 'Registre des carnets (RC)') },
  ];

  const context: SlipContext | null = refs
    ? { refs, userId, roles: navigation ? navigation.roles : null, now: clock.now() }
    : null;
  const resolution = context ? resolveSlip(form, context) : null;
  const photoTarget = slipPhotoTarget(form.slipType);

  const changeType = (slipType: ReportableSlipType) => {
    setForm((current) => ({
      ...initialForm(slipType),
      paperRef: current.paperRef,
      occurredAt: current.occurredAt,
      backdatedReason: current.backdatedReason,
    }));
    setPhoto(null);
    setShowIssues(false);
  };

  /** Après un envoi : même carnet, même lieu — seuls la pièce et ses lignes sont à ressaisir. */
  const resetForm = () => {
    setForm((current) => ({
      ...initialForm(current.slipType),
      locationId: current.locationId,
      toLocationId: current.toLocationId,
      siteId: current.siteId,
      accountId: current.accountId,
      toAccountId: current.toAccountId,
    }));
    setPhoto(null);
    setShowIssues(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || isPhotoBusy || !userId) return;
    setShowIssues(true);
    setSubmitError(null);
    if (!resolution || !resolution.ok) return;

    setSubmitting(true);
    try {
      await submitPaperSlipReport(resolution.slip, resolution.meta, userId, photo);
      setLastSubmittedRef(resolution.meta.paperRef);
      resetForm();
    } catch (err) {
      setSubmitError(t(saveErrorKey(err)));
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
        subtitle={t('piece.report_subtitle', 'Saisie des pièces de carnets à souche et registre')}
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
        // Validation faite par `resolveSlip` : un seul message, en français, qui liste tout ce qui manque
        // (la bulle native du navigateur n'en signale qu'un à la fois, dans la langue de l'appareil).
        <form onSubmit={handleSubmit} className="report-form" noValidate>
          {lastSubmittedRef ? (
            <Banner tone="ok">
              {t('piece.report_success', {
                ref: lastSubmittedRef,
                defaultValue: `Pièce ${lastSubmittedRef} enregistrée dans la file d’attente locale (outbox).`,
              })}
            </Banner>
          ) : null}

          {submitError ? <Banner tone="bad">{submitError}</Banner> : null}

          {showIssues && resolution && !resolution.ok ? (
            <Banner
              tone="bad"
              title={t('piece.issues_title', 'La pièce ne peut pas encore être enregistrée :')}
            >
              <ul className="report-issues">
                {resolution.issues.map((issue) => (
                  <li key={issue}>{t(`piece.issue.${issue}`, SLIP_ISSUE_MESSAGES[issue])}</li>
                ))}
              </ul>
            </Banner>
          ) : null}

          <Section title={t('piece.section_general', 'Informations du carnet papier')}>
            <div className="report-fields">
              <div className="report-grid-2">
                <Field label={t('piece.slip_type', 'Type de pièce')}>
                  {(ctrl) => (
                    <Select
                      {...ctrl}
                      value={form.slipType}
                      onChange={(e) => changeType(e.target.value as ReportableSlipType)}
                    >
                      {REPORTABLE_SLIP_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {SLIP_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field
                  label={t('piece.slip_ref', 'Numéro de la pièce (souche)')}
                  hint={t(
                    'piece.slip_ref_hint',
                    'Ex. BV-000142, RE-0045, BD-012… (20 caractères au plus)',
                  )}
                >
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      value={form.paperRef}
                      onChange={(e) => patch({ paperRef: e.target.value })}
                      placeholder="Ex. 000142"
                      maxLength={40}
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

              <Field label={t('piece.occurred_at', 'Date et heure manuscrite de la pièce')}>
                {(ctrl) => (
                  <Input
                    {...ctrl}
                    type="datetime-local"
                    value={form.occurredAt}
                    onChange={(e) => patch({ occurredAt: e.target.value })}
                    required
                  />
                )}
              </Field>

              {/* Évaluation de la fenêtre d'antidatage (AV-078) */}
              {backdatingEval.isCriticalDelay ? (
                <div className="report-continuity-alert">
                  <Banner tone="warn">
                    {t(
                      'piece.critical_delay_warning',
                      'Attention : le délai de report dépasse 72 h. Cette pièce fera l’objet d’une vérification comptable a posteriori.',
                    )}
                  </Banner>
                </div>
              ) : null}

              {backdatingEval.requiresReason ? (
                <Field
                  label={t('piece.backdated_reason', 'Motif de report / antidatage')}
                  hint={t(
                    'piece.backdated_reason_hint',
                    'Requis car la pièce a été signée il y a plus de 24 h.',
                  )}
                >
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      value={form.backdatedReason}
                      onChange={(e) => patch({ backdatedReason: e.target.value })}
                      placeholder="Ex. Retour de tournée terrain, carnet transmis le..."
                      maxLength={500}
                      required
                    />
                  )}
                </Field>
              ) : null}
            </div>
          </Section>

          {/* Champs propres au type de pièce : ce que le serveur exige de la commande */}
          {context ? (
            <SlipFields form={form} patch={patch} context={context} />
          ) : (
            <p className="field-hint">{t('sales.loading', 'Chargement des référentiels…')}</p>
          )}

          {/* Justificatif photo de la souche papier (MP-10, ADR-012) — seulement là où le serveur le rattache */}
          <Section title={t('piece.section_photo', 'Photo de la pièce papier (souche)')}>
            {photoTarget ? (
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
            ) : (
              <Banner tone="info">
                {t(
                  'piece.photo_unavailable',
                  'La photo de la souche ne peut pas encore être rattachée à ce type de pièce sur le serveur : conservez la souche papier dans le carnet.',
                )}
              </Banner>
            )}
          </Section>

          {/* Un seul bouton principal plein par écran (règle refonte) */}
          <ActionBar>
            <Button type="submit" variant="primary" disabled={submitting || isPhotoBusy || !refs}>
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
              {REPORTABLE_SLIP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SLIP_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </div>

          <div className="report-kpis">
            <Card padded>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
                {t('piece.total_slips', 'Total reporté')}
              </div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 'bold' }}>
                {continuity.totalCount}
              </div>
            </Card>

            <Card padded>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
                {t('piece.range', 'Plage (Min - Max)')}
              </div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'bold' }}>
                {continuity.range ? `N° ${continuity.range.min} → ${continuity.range.max}` : '—'}
              </div>
            </Card>

            <Card padded>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
                {t('piece.gaps_detected', 'Sauts détectés')}
              </div>
              <div
                style={{
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 'bold',
                  color: continuity.missingCount > 0 ? 'var(--warn)' : undefined,
                }}
              >
                {continuity.missingCount}
              </div>
            </Card>

            <Card padded>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
                {t('piece.duplicates_detected', 'Doublons détectés')}
              </div>
              <div
                style={{
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 'bold',
                  color: continuity.duplicates.length > 0 ? 'var(--bad)' : undefined,
                }}
              >
                {continuity.duplicates.length}
              </div>
            </Card>
          </div>

          {continuity.duplicates.length > 0 ? (
            <Banner tone="warn">
              {t('piece.duplicates_summary', {
                refs: continuity.duplicates.map((d) => `${d.ref} (${d.count}x)`).join(', '),
                defaultValue: `Doublons détectés : ${continuity.duplicates.map((d) => `${d.ref} (${d.count}x)`).join(', ')}.`,
              })}
            </Banner>
          ) : null}

          {continuity.missingCount > 0 ? (
            <Banner tone="info">
              {t('piece.gaps_summary', {
                gaps: continuity.missing
                  .map(
                    (entry) =>
                      `${entry.type} : ${entry.numbers.slice(0, 15).join(', ')}${entry.numbers.length > 15 ? '…' : ''}`,
                  )
                  .join(' ; '),
                defaultValue: `Numéros manquants dans la suite : ${continuity.missing
                  .map(
                    (entry) =>
                      `${entry.type} : ${entry.numbers.slice(0, 15).join(', ')}${entry.numbers.length > 15 ? '…' : ''}`,
                  )
                  .join(' ; ')}.`,
              })}
            </Banner>
          ) : null}

          {filteredSlips.length === 0 ? (
            <p style={{ color: 'var(--ink-3)', textAlign: 'center', padding: 'var(--space-6)' }}>
              {t('piece.no_slips', 'Aucune pièce papier enregistrée pour ce filtre.')}
            </p>
          ) : (
            <div className="report-slips-list">
              {filteredSlips.map((slip) => (
                <Card key={slip.commandId} className="report-slip-card" padded>
                  <div className="report-slip-card-header">
                    <div>
                      <Badge tone="muted">{slip.slipType}</Badge>{' '}
                      <span className="report-slip-ref">{slip.paperSlipRef}</span>
                    </div>
                    <Badge tone={STATUS_TONE[slip.status] ?? 'muted'}>
                      {t(`sync.status.${slip.status}`)}
                    </Badge>
                  </div>

                  <div className="report-slip-meta">
                    <span>
                      {t('piece.slip_date', 'Date sur pièce')} : {formatDateTime(slip.occurredAt)}
                    </span>
                    {slip.amountXaf !== null && slip.amountXaf !== undefined ? (
                      <span style={{ fontWeight: 600 }}>{formatMoney(slip.amountXaf)}</span>
                    ) : null}
                  </div>

                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink)' }}>
                    {slip.description}
                  </div>

                  {slip.backdatedReason ? (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
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
