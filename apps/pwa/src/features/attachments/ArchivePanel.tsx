/**
 * Onglet « Archive des photos » des paramètres (AV-539, ADR-070 ; Admin seulement, en ligne seulement) : choisir une
 * période (mois ou trimestre), préparer l'archive, télécharger ses fichiers rangés par type d'opération, vérifier les
 * fichiers rangés par leur empreinte (facultatif), puis **vider l'espace du serveur** après confirmation.
 *
 * Le serveur fait foi : plan figé, livraison complète d'un fichier, vérification, vidage. L'écran ne garde aucun état
 * qui ne se relise pas ; une action rend la main en relisant le catalogue et les archives, si bien que « ce qui reste
 * sur le serveur » est toujours celui du serveur. Les photos de moins de 30 jours et celles d'une opération encore
 * ouverte ne partent jamais (règles du serveur, rappelées dans les textes).
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveCatalog,
  ArchiveCatalogPeriod,
  ArchiveView,
  ArchiveVolumeView,
  DownloadTicket,
  PurgeResult,
} from '@gic/contracts';
import type { ArchiveGranularity } from '@gic/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Section,
  Segmented,
  Sheet,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useAdminRead } from '../admin/admin-online.js';
import { formatDateTime } from '../home/format-home.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import { ARCHIVES_PATH, archiveCall, archiveErrorKey, type ArchiveCall } from './archive-api.js';
import { startDownload, wait } from './archive-download.js';
import {
  DOWNLOAD_POLL_MAX,
  DOWNLOAD_POLL_MS,
  EMPTY_PURGE_RESULT,
  MAX_PURGE_CALLS,
  addPurgeResults,
  canCancel,
  canPurge,
  formatBytes,
  periodTitle,
  purgePreview,
  releasedReasons,
  volumeState,
  volumeWithHash,
  volumesToDownload,
  type VolumeState,
} from './archive.js';
import { sha256OfFile } from './sha256.js';
import './attachments.css';

interface Notice {
  readonly tone: 'ok' | 'warn' | 'bad' | 'info';
  readonly text: string;
}

const STATE_TONE: Readonly<Record<VolumeState, BadgeTone>> = {
  PENDING: 'warn',
  DELIVERED: 'info',
  VERIFIED: 'ok',
  RESOLVED: 'muted',
};

function useErrorText() {
  const { t } = useTranslation();
  return (failure: Extract<ArchiveCall<unknown>, { ok: false }>) =>
    t(archiveErrorKey(failure.code));
}

// ---------------------------------------------------------------------------------------------------------------
// Une archive en cours : fichiers, téléchargement, vérification, vidage
// ---------------------------------------------------------------------------------------------------------------

interface CardProps {
  readonly archive: ArchiveView;
  readonly minAgeDays: number;
  readonly onChanged: () => void;
  readonly onNotice: (notice: Notice | null) => void;
  readonly onPurged: (result: PurgeResult | null) => void;
}

function ArchiveCard({ archive, minAgeDays, onChanged, onNotice, onPurged }: CardProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const stop = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [batch, setBatch] = useState<{ current: number; total: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<{ name: string; percent: number } | null>(null);
  const [verifyLines, setVerifyLines] = useState<{ ok: boolean; text: string }[]>([]);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [purging, setPurging] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const title = periodTitle(archive.period, {
    first: t('archive.period.first'),
    quarter: (rank, year) => t('archive.period.quarter', { rank, year }),
  });
  const preview = purgePreview(archive);
  const working = batch !== null || busy !== null || verifying !== null || purging;

  /** Billet, puis téléchargement par le navigateur ; attend que le serveur ait fini d'écrire (ou que ça échoue). */
  async function downloadOne(
    volume: ArchiveVolumeView,
  ): Promise<'DELIVERED' | 'FAILED' | 'STOPPED'> {
    const ticket = await archiveCall<DownloadTicket>(
      'POST',
      `${ARCHIVES_PATH}/${archive.id}/volumes/${volume.id}/ticket`,
    );
    if (!ticket.ok) {
      onNotice({ tone: 'bad', text: errorText(ticket) });
      return 'FAILED';
    }
    startDownload(ticket.data.url);
    for (let poll = 0; poll < DOWNLOAD_POLL_MAX; poll += 1) {
      await wait(DOWNLOAD_POLL_MS);
      if (stop.current) return 'STOPPED';
      const view = await archiveCall<{ archive: ArchiveView }>(
        'GET',
        `${ARCHIVES_PATH}/${archive.id}`,
      );
      if (!view.ok) continue;
      const now = view.data.archive.volumes.find((candidate) => candidate.id === volume.id);
      if (now && now.deliveries > volume.deliveries) return 'DELIVERED';
      if (now && now.abortedDeliveries > volume.abortedDeliveries) return 'FAILED';
    }
    return 'FAILED';
  }

  async function downloadVolumes(volumes: readonly ArchiveVolumeView[]) {
    stop.current = false;
    onNotice(null);
    let outcome: 'DELIVERED' | 'FAILED' | 'STOPPED' = 'DELIVERED';
    for (const [index, volume] of volumes.entries()) {
      setBatch({ current: index + 1, total: volumes.length });
      outcome = await downloadOne(volume);
      onChanged();
      if (outcome !== 'DELIVERED') break;
    }
    setBatch(null);
    if (outcome === 'DELIVERED') onNotice({ tone: 'ok', text: t('archive.download_done') });
    else if (outcome === 'STOPPED') onNotice({ tone: 'info', text: t('archive.download_stopped') });
    else onNotice({ tone: 'bad', text: t('archive.download_failed') });
  }

  async function verifyFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const lines: { ok: boolean; text: string }[] = [];
    setVerifyLines([]);
    for (const file of Array.from(files)) {
      setVerifying({ name: file.name, percent: 0 });
      try {
        const sha256 = await sha256OfFile(file, (fraction) =>
          setVerifying({ name: file.name, percent: Math.round(fraction * 100) }),
        );
        const volume = volumeWithHash(archive, sha256);
        if (!volume) {
          lines.push({ ok: false, text: t('archive.verify_unknown', { name: file.name }) });
          continue;
        }
        const result = await archiveCall(
          'POST',
          `${ARCHIVES_PATH}/${archive.id}/volumes/${volume.id}/verify`,
          { sha256 },
        );
        lines.push(
          result.ok
            ? {
                ok: true,
                text: t('archive.verify_ok', { name: file.name, volume: volume.fileName }),
              }
            : {
                ok: false,
                text: t('archive.verify_error', { name: file.name, error: errorText(result) }),
              },
        );
      } catch {
        lines.push({
          ok: false,
          text: t('archive.verify_error', { name: file.name, error: t('archive.error.GENERIC') }),
        });
      }
    }
    setVerifying(null);
    setVerifyLines(lines);
    onChanged();
  }

  async function runPurge() {
    setPurging(true);
    onNotice(null);
    let total = EMPTY_PURGE_RESULT;
    let failure: Extract<ArchiveCall<unknown>, { ok: false }> | null = null;
    for (let call = 0; call < MAX_PURGE_CALLS; call += 1) {
      const response = await archiveCall<{ archive: ArchiveView; result: PurgeResult }>(
        'POST',
        `${ARCHIVES_PATH}/${archive.id}/purge`,
        { confirm: true },
        { long: true },
      );
      if (!response.ok) {
        failure = response;
        break;
      }
      total = addPurgeResults(total, response.data.result);
      if (response.data.result.remaining === 0) break;
    }
    setPurging(false);
    setConfirmPurge(false);
    setAcknowledged(false);
    onPurged(failure && total.purged === 0 ? null : total);
    if (failure) onNotice({ tone: 'bad', text: errorText(failure) });
    onChanged();
  }

  async function cancelArchive() {
    setBusy('cancel');
    const response = await archiveCall('POST', `${ARCHIVES_PATH}/${archive.id}/cancel`);
    setBusy(null);
    setConfirmCancel(false);
    onNotice(
      response.ok
        ? { tone: 'ok', text: t('archive.cancelled') }
        : { tone: 'bad', text: errorText(response) },
    );
    onChanged();
  }

  const toDownload = volumesToDownload(archive);
  return (
    <li className="line-card" aria-label={t('archive.card', { label: title })}>
      <div className="adm-card-head">
        <span className="adm-card-title">
          <strong>{title}</strong>
          <span className="adm-sub">
            {t('archive.summary', {
              files: archive.files,
              size: formatBytes(archive.filesBytes),
              volumes: archive.volumes.length,
            })}
          </span>
          <span className="adm-sub">
            {t('archive.cutoff', { date: formatDateTime(archive.cutoffAt) })}
          </span>
        </span>
        <Badge tone={archive.allDelivered ? 'ok' : 'warn'}>
          {archive.allDelivered ? t('archive.volume.DELIVERED') : t('archive.status.READY')}
        </Badge>
      </div>
      {archive.keptOpen > 0 ? (
        <p className="adm-note">{t('archive.kept_open', { count: archive.keptOpen })}</p>
      ) : null}
      {archive.absent > 0 ? (
        <p className="adm-note is-warn">{t('archive.absent', { count: archive.absent })}</p>
      ) : null}

      <ul className="adm-cards archive-volumes">
        {archive.volumes.map((volume) => {
          const state = volumeState(volume);
          return (
            <li key={volume.id} className="line-card archive-volume" aria-label={volume.fileName}>
              <div className="adm-card-head">
                <span className="adm-card-title">
                  <strong>
                    {`${t(`archive.category.${volume.category}`)} · ${periodTitle(
                      { granularity: 'MONTH', label: volume.month },
                      { first: '', quarter: () => '' },
                    )}`}
                  </strong>
                  <span className="adm-sub archive-file">{volume.fileName}</span>
                  <span className="adm-sub">
                    {t('archive.volume.line', {
                      files: volume.files,
                      size: formatBytes(volume.filesBytes),
                      zip: formatBytes(volume.zipBytes),
                    })}
                  </span>
                </span>
                <Badge tone={STATE_TONE[state]}>{t(`archive.volume.${state}`)}</Badge>
              </div>
              {volume.abortedDeliveries > 0 && state !== 'RESOLVED' ? (
                <p className="adm-note is-warn">
                  {t('archive.volume.aborted', { count: volume.abortedDeliveries })}
                </p>
              ) : null}
              {volume.released > 0 ? (
                <p className="adm-note">
                  {t('archive.volume.released', { count: volume.released })}
                </p>
              ) : null}
              {volume.zipSha256 && state !== 'RESOLVED' ? (
                <details className="archive-hash">
                  <summary>{t('archive.volume.hash_label')}</summary>
                  <code>{volume.zipSha256}</code>
                  <span className="adm-sub">
                    {t('archive.volume.hash_help', { name: volume.fileName })}
                  </span>
                  {volume.lastDeliveredAt ? (
                    <span className="adm-sub">
                      {t('archive.volume.delivered_at', {
                        date: formatDateTime(volume.lastDeliveredAt),
                      })}
                    </span>
                  ) : null}
                  {volume.verifiedAt ? (
                    <span className="adm-sub">
                      {t('archive.volume.verified_at', { date: formatDateTime(volume.verifiedAt) })}
                    </span>
                  ) : null}
                </details>
              ) : null}
              {state !== 'RESOLVED' ? (
                <div className="adm-actions">
                  <Button
                    variant="tonal"
                    size="sm"
                    icon="file"
                    disabled={working}
                    aria-label={t('archive.volume.download_label', { name: volume.fileName })}
                    onClick={() => {
                      setBusy(volume.id);
                      void downloadVolumes([volume]).finally(() => setBusy(null));
                    }}
                  >
                    {t('archive.volume.download')}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {batch ? (
        <Banner
          tone="info"
          role="status"
          action={
            <Button
              variant="tonal"
              size="sm"
              onClick={() => {
                stop.current = true;
              }}
            >
              {t('archive.download_stop')}
            </Button>
          }
        >
          {`${t('archive.download_progress', batch)} ${t('archive.download_waiting')}`}
        </Banner>
      ) : null}

      {toDownload.length > 0 && archive.status === 'READY' ? (
        <div className="adm-actions">
          <Button disabled={working} onClick={() => void downloadVolumes(toDownload)}>
            {t('archive.download_all')}
          </Button>
        </div>
      ) : null}

      {archive.status === 'READY' ? (
        <div className="adm-panel" role="group" aria-label={t('archive.verify_title')}>
          <strong>{t('archive.verify_title')}</strong>
          <p className="adm-note">{t('archive.verify_help')}</p>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            multiple
            hidden
            data-testid="archive-file-input"
            onChange={(event) => {
              const input = event.currentTarget;
              void verifyFiles(input.files).finally(() => {
                input.value = '';
              });
            }}
          />
          <div className="adm-actions">
            <Button
              variant="tonal"
              size="sm"
              icon="file"
              disabled={working}
              onClick={() => fileInput.current?.click()}
            >
              {t('archive.verify_choose')}
            </Button>
          </div>
          {verifying ? (
            <p className="adm-note" role="status">
              {t('archive.verify_progress', verifying)}
            </p>
          ) : null}
          {verifyLines.length > 0 ? (
            <ul className="archive-verify-lines">
              {verifyLines.map((line, index) => (
                <li key={index} className={line.ok ? 'is-ok' : 'is-bad'}>
                  {line.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {archive.status === 'READY' ? (
        <div className="adm-actions">
          <Button
            variant="danger"
            disabled={!canPurge(archive) || working}
            onClick={() => setConfirmPurge(true)}
          >
            {t('archive.purge')}
          </Button>
          {canCancel(archive) && !confirmCancel ? (
            <Button variant="ghost" disabled={working} onClick={() => setConfirmCancel(true)}>
              {t('archive.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!canPurge(archive) && archive.status === 'READY' ? (
        <p className="adm-note">{t('archive.purge_blocked')}</p>
      ) : null}
      {confirmCancel ? (
        <div className="adm-panel" role="group" aria-label={t('archive.cancel')}>
          <p className="adm-note">{t('archive.cancel_confirm')}</p>
          <div className="adm-actions">
            <Button
              variant="tonal"
              size="sm"
              disabled={busy !== null}
              onClick={() => void cancelArchive()}
            >
              {t('archive.cancel_yes')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
              {t('archive.cancel_no')}
            </Button>
          </div>
        </div>
      ) : null}

      <Sheet
        open={confirmPurge}
        onClose={() => {
          if (!purging) setConfirmPurge(false);
        }}
        title={t('archive.purge_title')}
        footer={
          <>
            <Button variant="ghost" disabled={purging} onClick={() => setConfirmPurge(false)}>
              {t('archive.purge_cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={!acknowledged || purging}
              onClick={() => void runPurge()}
            >
              {purging ? t('archive.purge_running') : t('archive.purge_confirm')}
            </Button>
          </>
        }
      >
        <p>
          {t('archive.purge_summary', {
            files: preview.files,
            size: formatBytes(preview.bytes),
            volumes: preview.volumes,
          })}
        </p>
        <p>{t('archive.purge_kept', { days: minAgeDays })}</p>
        {preview.unverified > 0 ? (
          <Banner tone="warn" role="status">
            {t('archive.purge_unverified', { count: preview.unverified })}
          </Banner>
        ) : null}
        <Checkbox
          label={t('archive.purge_ack', { volumes: preview.volumes })}
          checked={acknowledged}
          disabled={purging}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
      </Sheet>
    </li>
  );
}

function PurgeSummary({ result, onDismiss }: { result: PurgeResult; onDismiss: () => void }) {
  const { t } = useTranslation();
  const reasons = releasedReasons(result.released);
  const kept = reasons.reduce((sum, item) => sum + item.count, 0);
  const text = [
    t('archive.purge_done', { purged: result.purged, size: formatBytes(result.bytesFreed) }),
    kept > 0
      ? t('archive.purge_released', {
          count: kept,
          reasons: reasons
            .map((item) => `${item.count} ${t(`archive.released_reason.${item.reason}`)}`)
            .join(', '),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Banner tone={kept > 0 ? 'warn' : 'ok'} role="status" onDismiss={onDismiss}>
      {text}
    </Banner>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Une période du catalogue
// ---------------------------------------------------------------------------------------------------------------

function PeriodCard({
  period,
  minAgeDays,
  preparing,
  onPrepare,
}: {
  readonly period: ArchiveCatalogPeriod;
  readonly minAgeDays: number;
  readonly preparing: boolean;
  readonly onPrepare: (period: ArchiveCatalogPeriod) => void;
}) {
  const { t } = useTranslation();
  const title = periodTitle(period, {
    first: t('archive.period.first'),
    quarter: (rank, year) => t('archive.period.quarter', { rank, year }),
  });
  const archivable = period.olderThanMinAge;
  return (
    <li className="line-card" aria-label={t('archive.period_card', { label: title })}>
      <div className="adm-card-head">
        <span className="adm-card-title">
          <strong>{title}</strong>
          <span className="adm-sub">
            {archivable.files > 0
              ? t('archive.period_archivable', {
                  files: archivable.files,
                  size: formatBytes(archivable.bytes),
                })
              : t('archive.period_nothing')}
          </span>
          {period.recent.files > 0 ? (
            <span className="adm-sub">
              {t('archive.period_recent', { days: minAgeDays, files: period.recent.files })}
            </span>
          ) : null}
          {period.archived.files > 0 ? (
            <span className="adm-sub">
              {t('archive.period_archived', { files: period.archived.files })}
            </span>
          ) : null}
        </span>
        {period.planId !== null ? (
          <Badge tone="info">{t('archive.period_in_progress')}</Badge>
        ) : null}
      </div>
      {period.planId === null && archivable.files > 0 ? (
        <div className="adm-actions">
          <Button
            variant="tonal"
            size="sm"
            disabled={preparing}
            aria-label={`${t('archive.prepare')} — ${title}`}
            onClick={() => onPrepare(period)}
          >
            {preparing ? t('archive.preparing') : t('archive.prepare')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// L'onglet
// ---------------------------------------------------------------------------------------------------------------

export function ArchivePanel() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [choice, setChoice] = useState<ArchiveGranularity | null>(null);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [purgeResult, setPurgeResult] = useState<PurgeResult | null>(null);
  const reloadKey = String(reload);
  const refresh = () => setReload((value) => value + 1);

  const catalog = useAdminRead<ArchiveCatalog>(
    `${ARCHIVES_PATH}/catalog${choice ? `?granularity=${choice}` : ''}`,
    reloadKey,
  );
  const archives = useAdminRead<{ archives: ArchiveView[] }>(ARCHIVES_PATH, reloadKey);

  const granularity = choice ?? catalog.data?.granularity ?? 'QUARTER';
  const settings = catalog.data?.settings;
  const minAgeDays = settings?.minAgeDays ?? 30;
  const live = archives.data?.archives.filter((archive) => archive.status === 'READY') ?? [];
  const history =
    archives.data?.archives.filter((archive) => archive.status !== 'READY').slice(0, 5) ?? [];
  const periods =
    catalog.data?.periods.filter(
      (period) => period.onServer.files > 0 || period.archived.files > 0 || period.planId !== null,
    ) ?? [];

  async function prepare(period: ArchiveCatalogPeriod) {
    setPreparing(period.start);
    setNotice(null);
    const response = await archiveCall<{ archive: ArchiveView }>(
      'POST',
      ARCHIVES_PATH,
      { granularity, periodStart: period.start },
      { long: true },
    );
    setPreparing(null);
    setNotice(
      response.ok
        ? {
            tone: 'ok',
            text: t('archive.created', { volumes: response.data.archive.volumes.length }),
          }
        : { tone: 'bad', text: errorText(response) },
    );
    refresh();
  }

  const failed = catalog.failed || archives.failed;
  const denied = catalog.denied || archives.denied;
  return (
    <>
      <HelpDisclosure title={t('archive.help_title')}>
        <p>{t('archive.intro', { days: minAgeDays })}</p>
        <p>{t('archive.steps')}</p>
        <p>{t('archive.retention', { years: settings?.retentionYears ?? 5 })}</p>
      </HelpDisclosure>

      {notice ? (
        <Banner tone={notice.tone} role="status" onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      ) : null}
      {purgeResult ? (
        <PurgeSummary result={purgeResult} onDismiss={() => setPurgeResult(null)} />
      ) : null}
      {failed ? (
        <Banner
          tone="bad"
          action={
            denied ? undefined : (
              <Button
                variant="tonal"
                size="sm"
                onClick={() => {
                  catalog.retry();
                  archives.retry();
                }}
              >
                {t('archive.retry')}
              </Button>
            )
          }
        >
          {denied ? t('archive.denied') : t('archive.unavailable')}
        </Banner>
      ) : null}

      {catalog.data ? (
        <p className="adm-note" role="status">
          {t('archive.server_summary', {
            files: catalog.data.server.files,
            size: formatBytes(catalog.data.server.bytes),
          })}
        </p>
      ) : null}
      {catalog.data === undefined && archives.data === undefined && !failed ? (
        <SkeletonRows />
      ) : null}

      {archives.data ? (
        <Section title={t('archive.active_title')}>
          {live.length === 0 ? (
            <p className="adm-note">{t('archive.active_none')}</p>
          ) : (
            <ul className="adm-cards">
              {live.map((archive) => (
                <ArchiveCard
                  key={archive.id}
                  archive={archive}
                  minAgeDays={archive.minAgeDays}
                  onChanged={refresh}
                  onNotice={setNotice}
                  onPurged={setPurgeResult}
                />
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {catalog.data ? (
        <Section title={t('archive.periods_title')}>
          <Segmented
            label={t('archive.granularity_label')}
            value={granularity}
            options={(['QUARTER', 'MONTH'] as const).map((value) => ({
              value,
              label: t(`archive.granularity.${value}`),
            }))}
            onChange={(value) => setChoice(value)}
          />
          {periods.length === 0 ? (
            <EmptyState icon="camera" title={t('archive.periods_none')} />
          ) : (
            <ul className="adm-cards">
              {periods.map((period) => (
                <PeriodCard
                  key={period.start}
                  period={period}
                  minAgeDays={minAgeDays}
                  preparing={preparing === period.start}
                  onPrepare={(value) => void prepare(value)}
                />
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {history.length > 0 ? (
        <Section title={t('archive.history_title')}>
          <ul className="archive-history">
            {history.map((archive) => {
              const title = periodTitle(archive.period, {
                first: t('archive.period.first'),
                quarter: (rank, year) => t('archive.period.quarter', { rank, year }),
              });
              return (
                <li key={archive.id}>
                  {archive.status === 'COMPLETED'
                    ? t('archive.history_line', {
                        period: title,
                        files: archive.volumes.reduce((total, volume) => total + volume.purged, 0),
                        date: formatDateTime(archive.completedAt ?? archive.createdAt),
                      })
                    : t('archive.history_cancelled', {
                        period: title,
                        date: formatDateTime(archive.cancelledAt ?? archive.createdAt),
                      })}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
