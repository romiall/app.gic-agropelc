/**
 * ECR-IMP-01 « Charger des données » (RP-2, PP-C ; AV-072, AV-317, AV-508) : chargement par fichier CSV des catégories
 * de produit, des produits, des fournisseurs et des clients. Le fichier est lu et contrôlé sur l'appareil, ligne par
 * ligne, avec les contrôles des écrans de saisie ; rien n'est écrit tant que l'utilisateur ne charge pas. Chaque ligne
 * prête devient les commandes que ces écrans envoient (outbox, principe O1) : validées par le serveur, auditées, et
 * sans doublon si le même fichier est rechargé (identifiants stables, `importEntityId`).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { holdsAnyRole } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { downloadTextFile } from '../../platform/download.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { MAX_BACKDATED_REASON } from '../pieces/report-commands.js';
import { useSalesReferences } from '../sales/references.js';
import { phaseOf, rejectionMessage, saveErrorKey, submitCommand } from '../sales/submit.js';
import { buildImportRefs } from './context.js';
import { CsvTooLargeError, decodeCsv, parseCsv, toCsv, type ParsedCsv } from './csv.js';
import { IMPORT_ENTITIES } from './entities.js';
import {
  planImport,
  templateRows,
  type ImportEntity,
  type ImportPlan,
  type RowStatus,
} from './model.js';
import type { ImportRefs } from './refs.js';
import './import.css';

/** Lignes listées au rapport de contrôle : le reste est compté, pas détaillé. */
const MAX_LISTED_ROWS = 100;
/** Lignes refusées détaillées au résultat. */
const MAX_LISTED_REJECTED = 100;
/** Le compteur d'avancement ne se met à jour que par paquets, pour ne pas redessiner l'écran à chaque ligne. */
const PROGRESS_STEP = 25;

interface SentRow {
  readonly commandId: string;
  readonly line: number;
  readonly key: string;
}

type Phase = 'idle' | 'checking' | 'ready' | 'sending' | 'sent';

const STATUS_TONE: Readonly<Record<RowStatus, BadgeTone>> = {
  READY: 'ok',
  EXISTS: 'muted',
  ERROR: 'bad',
  DUPLICATE_IN_FILE: 'warn',
};

/** Les erreurs d'abord, puis les doublons du fichier, puis les lignes déjà présentes. */
const STATUS_ORDER: Readonly<Record<RowStatus, number>> = {
  ERROR: 0,
  DUPLICATE_IN_FILE: 1,
  EXISTS: 2,
  READY: 3,
};

async function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Response(file).arrayBuffer();
}

/** Les mêmes référentiels, avec l'heure du contrôle : « maintenant » sert aux fenêtres d'antidatage et au futur. */
function withNow(refs: ImportRefs, now: Date): ImportRefs {
  return refs.slipContext ? { ...refs, slipContext: { ...refs.slipContext, now } } : refs;
}

function ColumnsHelp({ entity }: { entity: ImportEntity }) {
  const { t } = useTranslation();
  return (
    <details className="import-columns card card-pad">
      <summary>{t('data_import.columns_title')}</summary>
      <ul>
        {entity.columns.map((column) => (
          <li key={column.key}>
            <span className="import-column-name">
              {column.label}
              <Badge tone={column.required ? 'brand' : 'muted'} plain>
                {t(column.required ? 'data_import.column_required' : 'data_import.column_optional')}
              </Badge>
            </span>
            {column.hint ? <p className="import-column-hint">{column.hint}</p> : null}
            {column.example ? (
              <p className="import-column-hint">
                {t('data_import.column_example', { example: column.example })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PlanView({ plan, fileName }: { plan: ImportPlan; fileName: string }) {
  const { t } = useTranslation();
  const listed = plan.rows
    .filter((row) => row.status !== 'READY')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.line - b.line);
  const shown = listed.slice(0, MAX_LISTED_ROWS);
  return (
    <>
      <p className="import-file-name">{t('data_import.file_name', { name: fileName })}</p>
      {plan.fileIssues.map((issue) => (
        <Banner key={issue} tone="bad">
          {issue}
        </Banner>
      ))}
      {plan.missingColumns.length > 0 ? (
        <Banner tone="bad">
          {t('data_import.missing_columns', { columns: plan.missingColumns.join(', ') })}
        </Banner>
      ) : null}
      {plan.unknownColumns.length > 0 ? (
        <Banner tone="warn" role="status">
          {t('data_import.unknown_columns', { columns: plan.unknownColumns.join(', ') })}
        </Banner>
      ) : null}
      {plan.missingColumns.length === 0 &&
      plan.fileIssues.length === 0 &&
      plan.rows.length === 0 ? (
        <Banner tone="warn" role="status">
          {t('data_import.no_rows')}
        </Banner>
      ) : null}
      {plan.rows.length > 0 ? (
        <div className="import-counts">
          <Badge tone="ok">{t('data_import.count_ready', { count: plan.counts.READY })}</Badge>
          <Badge tone="muted">{t('data_import.count_exists', { count: plan.counts.EXISTS })}</Badge>
          <Badge tone={plan.counts.ERROR > 0 ? 'bad' : 'muted'}>
            {t('data_import.count_error', { count: plan.counts.ERROR })}
          </Badge>
          <Badge tone={plan.counts.DUPLICATE_IN_FILE > 0 ? 'warn' : 'muted'}>
            {t('data_import.count_duplicate', { count: plan.counts.DUPLICATE_IN_FILE })}
          </Badge>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <Section title={t('data_import.rows_title')}>
          <DataList
            aria-label={t('data_import.rows_title')}
            columns={[
              { label: t('data_import.col.line') },
              { label: t('data_import.col.key') },
              { label: t('data_import.col.status') },
              { label: t('data_import.col.detail') },
            ]}
            template="4.5rem minmax(0, 1.6fr) 9rem minmax(0, 3fr)"
          >
            {shown.map((row) => (
              <DataRow key={row.line} aria-label={`${t('data_import.col.line')} ${row.line}`}>
                <DataCell label={t('data_import.col.line')} numeric>
                  {row.line}
                </DataCell>
                <DataCell label={t('data_import.col.key')} primary>
                  <span className="import-key">{row.key || '—'}</span>
                </DataCell>
                <DataCell label={t('data_import.col.status')}>
                  <Badge tone={STATUS_TONE[row.status]}>
                    {t(`data_import.status.${row.status}`)}
                  </Badge>
                </DataCell>
                <DataCell label={t('data_import.col.detail')} wide>
                  <span className="import-detail">
                    {row.status === 'EXISTS'
                      ? t('data_import.exists_detail')
                      : row.issues.join(' ')}
                  </span>
                </DataCell>
              </DataRow>
            ))}
          </DataList>
          {listed.length > shown.length ? (
            <p className="import-more">
              {t('data_import.rows_more', { count: listed.length - shown.length })}
            </p>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

/** Suivi en direct des commandes envoyées dans l'outbox : en attente, enregistrées, refusées avec leur motif. */
function ResultView({ sent }: { sent: readonly SentRow[] }) {
  const { t } = useTranslation();
  const ids = useMemo(() => sent.map((row) => row.commandId), [sent]);
  const commands = useLiveQuery(
    async () => (ids.length > 0 ? await getDb().outbox.bulkGet(ids) : []),
    [ids],
  );
  if (sent.length === 0) return null;
  if (commands === undefined) return <SkeletonRows rows={2} />;

  const tally = { WAITING: 0, DONE: 0, WARNING: 0, CONFLICT: 0, REJECTED: 0 };
  const rejected: { row: SentRow; reason: string }[] = [];
  commands.forEach((command, index) => {
    if (command === undefined) return;
    const phase = phaseOf(command);
    tally[phase] += 1;
    if (phase === 'REJECTED') {
      rejected.push({
        row: sent[index]!,
        reason: rejectionMessage(command) ?? t('data_import.rejected_unknown'),
      });
    }
  });
  const settled = tally.WAITING === 0;
  const accepted = tally.DONE + tally.WARNING;

  return (
    <Section title={t('data_import.result_title')}>
      <div className="import-counts">
        {tally.WAITING > 0 ? (
          <Badge tone="info">{t('data_import.result_waiting', { count: tally.WAITING })}</Badge>
        ) : null}
        <Badge tone={tally.DONE > 0 ? 'ok' : 'muted'}>
          {t('data_import.result_done', { count: tally.DONE })}
        </Badge>
        {tally.WARNING > 0 ? (
          <Badge tone="warn">{t('data_import.result_warning', { count: tally.WARNING })}</Badge>
        ) : null}
        {tally.CONFLICT > 0 ? (
          <Badge tone="warn">{t('data_import.result_review', { count: tally.CONFLICT })}</Badge>
        ) : null}
        <Badge tone={tally.REJECTED > 0 ? 'bad' : 'muted'}>
          {t('data_import.result_rejected', { count: tally.REJECTED })}
        </Badge>
      </div>
      {!settled ? (
        <Banner tone="info" role="status">
          {t('data_import.result_sent_waiting')}
        </Banner>
      ) : null}
      {settled && tally.REJECTED === 0 && tally.CONFLICT === 0 ? (
        <Banner tone="ok" role="status">
          {t('data_import.result_all_done', { count: accepted })}
        </Banner>
      ) : null}
      {rejected.length > 0 ? (
        <>
          <Banner tone="bad">{t('data_import.reload_hint')}</Banner>
          <DataList
            aria-label={t('data_import.rejected_title')}
            columns={[
              { label: t('data_import.col.line') },
              { label: t('data_import.col.key') },
              { label: t('data_import.col.detail') },
            ]}
            template="4.5rem minmax(0, 1.6fr) minmax(0, 4fr)"
          >
            {rejected.slice(0, MAX_LISTED_REJECTED).map(({ row, reason }) => (
              <DataRow key={row.commandId} aria-label={`${t('data_import.col.line')} ${row.line}`}>
                <DataCell label={t('data_import.col.line')} numeric>
                  {row.line}
                </DataCell>
                <DataCell label={t('data_import.col.key')} primary>
                  <span className="import-key">{row.key || '—'}</span>
                </DataCell>
                <DataCell label={t('data_import.col.detail')} wide>
                  <span className="import-detail">{reason}</span>
                </DataCell>
              </DataRow>
            ))}
          </DataList>
          {rejected.length > MAX_LISTED_REJECTED ? (
            <p className="import-more">
              {t('data_import.rows_more', { count: rejected.length - MAX_LISTED_REJECTED })}
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

export function ImportScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const references = useSalesReferences();
  const online = useOnline();
  const roles = useMemo(() => (navigation ? navigation.roles : []), [navigation]);

  const [kind, setKind] = useState<string>();
  const [file, setFile] = useState<{ readonly name: string; readonly csv: ParsedCsv }>();
  const [plan, setPlan] = useState<ImportPlan>();
  const [fileError, setFileError] = useState<string>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [sent, setSent] = useState<readonly SentRow[]>([]);
  const [stopped, setStopped] = useState<string>();
  /** Motif d'antidatage commun aux pièces papier de plus de 24 h dont le fichier ne donne pas de motif. */
  const [commonReason, setCommonReason] = useState('');
  /** Motif commun pris en compte par le dernier contrôle : s'il a changé depuis, « Charger » recontrôle d'abord. */
  const [checkedReason, setCheckedReason] = useState('');
  /** Numéro du dernier contrôle lancé : le résultat d'un contrôle dépassé est ignoré. */
  const checkTicket = useRef(0);
  const result = useRef<HTMLDivElement>(null);

  // « Charger » disparaît à la fin de l'envoi : le focus passe au résultat, qui s'annonce.
  useEffect(() => {
    if (phase === 'sent') result.current?.focus();
  }, [phase]);

  const available = useMemo(
    () => IMPORT_ENTITIES.filter((entity) => holdsAnyRole(roles, entity.roles)),
    [roles],
  );
  const elsewhere = IMPORT_ENTITIES.filter((entity) => !available.includes(entity));
  const entity = available.find((candidate) => candidate.id === kind) ?? available[0];

  const importRefs = useMemo(
    () =>
      references && userId
        ? buildImportRefs({ references, userId, roles, now: clock.now() })
        : undefined,
    [references, userId, roles],
  );

  if (!importRefs || !userId) {
    return (
      <section className="import-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.data_import')} />
        <SkeletonRows rows={4} />
      </section>
    );
  }

  const busy = phase === 'checking' || phase === 'sending';
  /** Le motif commun a changé depuis le dernier contrôle : le plan affiché ne le prend pas encore en compte. */
  const reasonChanged = commonReason.trim() !== checkedReason;
  const total = plan
    ? plan.rows.reduce((sum, row) => sum + (row.status === 'READY' ? row.commands.length : 0), 0)
    : 0;

  const check = async (target: ImportEntity, csv: ParsedCsv) => {
    checkTicket.current += 1;
    const ticket = checkTicket.current;
    setPhase('checking');
    setPlan(undefined);
    setFileError(undefined);
    const reason = commonReason.trim();
    const current = withNow(importRefs, clock.now());
    try {
      const checked = await planImport(
        target,
        csv,
        reason === '' ? current : { ...current, defaultBackdatedReason: reason },
      );
      if (ticket !== checkTicket.current) return;
      setCheckedReason(reason);
      setPlan(checked);
      setPhase('ready');
    } catch {
      // Un contrôle qui échoue ne fige pas l'écran en « contrôle en cours ».
      if (ticket !== checkTicket.current) return;
      setFileError(t('data_import.check_failed'));
      setPhase('idle');
    }
  };

  const reset = () => {
    checkTicket.current += 1;
    setFile(undefined);
    setPlan(undefined);
    setFileError(undefined);
    setSent([]);
    setStopped(undefined);
    setProgress(0);
    setPhase('idle');
  };

  const chooseKind = (id: string) => {
    const next = available.find((candidate) => candidate.id === id);
    if (!next || next.id === entity?.id) return;
    if (phase === 'sent') reset();
    setKind(id);
    if (file && phase !== 'sent') void check(next, file.csv);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // Le même fichier, corrigé puis choisi de nouveau, doit relancer le contrôle.
    event.target.value = '';
    if (!chosen || !entity) return;
    reset();
    // Occupé dès la lecture : le type de données ne peut pas changer sous le fichier en cours de lecture.
    setPhase('checking');
    try {
      const csv = parseCsv(decodeCsv(await readBytes(chosen)));
      if (csv.header.length === 0) {
        setFileError(t('data_import.file_error_empty'));
        setPhase('idle');
        return;
      }
      setFile({ name: chosen.name, csv });
      await check(entity, csv);
    } catch (error) {
      setFile(undefined);
      setPhase('idle');
      setFileError(
        error instanceof CsvTooLargeError
          ? t('data_import.file_error_large', { max: error.max })
          : t('data_import.file_error_read'),
      );
    }
  };

  const load = async () => {
    if (!plan || phase !== 'ready') return;
    // Le motif commun a changé depuis le contrôle : le fichier est recontrôlé avec lui, et l'utilisateur voit ce qui
    // sera chargé avant de confirmer (rien ne part sur un contrôle qui ne tient plus).
    if (entity && file && reasonChanged) {
      await check(entity, file.csv);
      return;
    }
    setPhase('sending');
    setStopped(undefined);
    setProgress(0);
    const queued: SentRow[] = [];
    try {
      for (const row of plan.rows) {
        if (row.status !== 'READY') continue;
        for (const command of row.commands) {
          const entry = await submitCommand({
            authorUserId: userId,
            commandType: command.commandType,
            aggregateType: command.aggregateType,
            aggregateId: command.aggregateId,
            payload: command.payload,
            // Pièce papier : heure et motif de la pièce, fait accompli saisi hors du système (BR-SYN-007).
            ...(command.occurredAt !== undefined ? { occurredAt: command.occurredAt } : {}),
            ...(command.backdatedReason !== undefined
              ? { backdatedReason: command.backdatedReason }
              : {}),
            ...(command.capturedOffline !== undefined
              ? { capturedOffline: command.capturedOffline }
              : {}),
            ...(command.dependsOn !== undefined ? { dependsOn: command.dependsOn } : {}),
            ...(command.localFlags !== undefined ? { localFlags: command.localFlags } : {}),
          });
          queued.push({ commandId: entry.command_id, line: row.line, key: row.key });
          if (queued.length % PROGRESS_STEP === 0) setProgress(queued.length);
        }
      }
    } catch (error) {
      // Lecture seule (autonomie dépassée) ou échec de la base locale : ce qui est déjà en file part quand même.
      setStopped(t('data_import.stopped', { done: queued.length, reason: t(saveErrorKey(error)) }));
    }
    setSent(queued);
    setProgress(queued.length);
    setPhase('sent');
  };

  const download = () => {
    if (entity) downloadTextFile(`modele-${entity.id}.csv`, toCsv(templateRows(entity)));
  };

  return (
    <section className="import-screen">
      <PageHeader title={t('nav.screens.data_import')} />
      <p className="import-intro">{t('data_import.intro')}</p>
      {!online ? (
        <Banner tone="warn" role="status">
          {t('data_import.offline')}
        </Banner>
      ) : null}
      {!entity ? (
        <EmptyState icon="lock" title={t('data_import.kind_none')} />
      ) : (
        <>
          <div className="import-form">
            <Field label={t('data_import.kind_label')} hint={entity.description}>
              {(control) => (
                <Select
                  {...control}
                  value={entity.id}
                  disabled={busy}
                  onChange={(event) => chooseKind(event.target.value)}
                >
                  {available.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {elsewhere.length > 0 ? (
              <p className="import-column-hint">
                {t('data_import.kind_other_roles', {
                  kinds: elsewhere.map((other) => other.label).join(', '),
                })}
              </p>
            ) : null}
            <div className="import-actions">
              <Button variant="outline" icon="file" onClick={download}>
                {t('data_import.template_download')}
              </Button>
            </div>
            <ColumnsHelp entity={entity} />
            {entity.id === 'slips' ? (
              <>
                <Field
                  label={t('data_import.reason_label')}
                  hint={t('data_import.reason_hint')}
                  optional
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={commonReason}
                      maxLength={MAX_BACKDATED_REASON}
                      disabled={busy}
                      onChange={(event) => setCommonReason(event.target.value)}
                    />
                  )}
                </Field>
                {/* Bouton explicite plutôt qu'un recontrôle au départ du champ : celui-ci faisait disparaître « Charger »
                    sous le doigt, et le clic se perdait. */}
                {file && phase === 'ready' && reasonChanged ? (
                  <div className="import-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void check(entity, file.csv)}
                    >
                      {t('data_import.reason_apply')}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
            <Field
              label={t('data_import.file_label')}
              hint={t('data_import.file_hint')}
              error={fileError}
            >
              {(control) => (
                <Input
                  {...control}
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  disabled={busy}
                  onChange={(event) => void chooseFile(event)}
                />
              )}
            </Field>
          </div>

          {phase === 'checking' ? (
            <div aria-busy="true">
              <p className="import-progress" role="status">
                {t('data_import.checking')}
              </p>
              <SkeletonRows rows={3} />
            </div>
          ) : null}
          {plan && file ? <PlanView plan={plan} fileName={file.name} /> : null}
          {plan && phase === 'ready' && reasonChanged ? (
            <Banner tone="info" role="status">
              {t('data_import.reason_changed')}
            </Banner>
          ) : null}
          {phase === 'sending' ? (
            <p className="import-progress" role="status">
              {t('data_import.loading', { done: progress, total })}
            </p>
          ) : null}
          {stopped ? <Banner tone="bad">{stopped}</Banner> : null}
          {phase === 'sent' ? (
            <>
              <div ref={result} tabIndex={-1} className="import-result">
                <ResultView sent={sent} />
              </div>
              <div className="import-actions">
                <Button variant="outline" onClick={reset}>
                  {t('data_import.another')}
                </Button>
              </div>
            </>
          ) : null}
          {plan && (phase === 'ready' || phase === 'sending') ? (
            <ActionBar>
              <Button
                loading={phase === 'sending'}
                disabled={
                  busy ||
                  total === 0 ||
                  plan.missingColumns.length > 0 ||
                  plan.fileIssues.length > 0
                }
                onClick={() => void load()}
              >
                {t('data_import.load_action', { count: total })}
              </Button>
            </ActionBar>
          ) : null}
        </>
      )}
    </section>
  );
}
