/**
 * ECR-NOT-01 « Centre d'alertes et de notifications » (tous rôles, hors ligne possible pour
 * la lecture des alertes/notifications projetées, l'acquittement d'alerte et le marquage de
 * notification lue ; résolution/rejet et règles d'alerte en ligne).
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type {
  AlertItem,
  AlertListResponse,
  AlertRuleItem,
  AlertRuleListResponse,
  AlertSummary,
  NotificationItem,
  NotificationListResponse,
} from '@gic/contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { listProjected } from '../../storage/projections.js';
import { useAdminRead, useOnlineCommands } from '../admin/admin-online.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { saveErrorKey, submitCommand } from '../sales/submit.js';
import {
  ALERT_RULES_PATH,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_SUMMARY_PATH,
  alertsListPath,
  buildAlertAckPayload,
  buildAlertDismissPayload,
  buildAlertResolvePayload,
  buildAlertRuleSetPayload,
  buildNotificationReadPayload,
  canManuallyCloseAlert,
  filterProjectedAlerts,
  fromProjectedNotifications,
  notificationsListPath,
  routeOfActionScreen,
  routeOfNotification,
  summarizeAlerts,
  type AlertSeverity,
  type AlertStatus,
} from './alerts.js';
import './communication.css';

type Tab = 'alerts' | 'notifications' | 'rules';

const severityBadgeTone = (severity: AlertSeverity): BadgeTone => {
  if (severity === 'CRITICAL') return 'bad';
  if (severity === 'WARNING') return 'warn';
  return 'info';
};

const statusBadgeTone = (status: AlertStatus): BadgeTone => {
  if (status === 'OPEN') return 'bad';
  if (status === 'ACKNOWLEDGED') return 'warn';
  if (status === 'RESOLVED') return 'ok';
  return 'muted';
};

export function AlertsNotificationsScreen() {
  const { t } = useTranslation();
  const online = useOnline();
  const { state } = useAuth();
  const unlocked = state.status === 'unlocked' ? state : undefined;
  const navigation = useRememberedNavigation(unlocked?.userId);
  const roles = navigation?.roles ?? [];
  const canManageRules = roles.some((r) => r === 'DIRECTION' || r === 'ADMIN');

  const [tab, setTab] = useState<Tab>('alerts');
  const [statusFilter, setStatusFilter] = useState<'' | AlertStatus>('');
  const [severityFilter, setSeverityFilter] = useState<'' | AlertSeverity>('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const [lastCmdId, setLastCmdId] = useState<string | undefined>(undefined);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [localReload, setLocalReload] = useState(0);

  const [activeAction, setActiveAction] = useState<{
    alertId: string;
    mode: 'ACK' | 'RESOLVE' | 'DISMISS';
  } | null>(null);
  const [actionText, setActionText] = useState('');

  const [editingRule, setEditingRule] = useState<{
    alertType: AlertRuleItem['alertType'];
    enabled: boolean;
    severity: AlertSeverity;
    escalationHours: string;
  } | null>(null);

  const onlineCommands = useOnlineCommands('communication.');
  const reloadKey = `${onlineCommands.reloadKey}:${localReload}`;

  const alertsRead = useAdminRead<AlertListResponse>(
    online ? alertsListPath({ status: statusFilter, severity: severityFilter }) : null,
    reloadKey,
  );
  const summaryRead = useAdminRead<AlertSummary>(online ? ALERT_SUMMARY_PATH : null, reloadKey);
  const notifsRead = useAdminRead<NotificationListResponse>(
    online ? notificationsListPath({ unreadOnly }) : null,
    reloadKey,
  );
  const rulesRead = useAdminRead<AlertRuleListResponse>(
    online && canManageRules && tab === 'rules' ? ALERT_RULES_PATH : null,
    reloadKey,
  );

  const offlineAlerts = useLiveQuery(async () => {
    const db = getDb();
    const records = await listProjected<unknown>(db, 'comms', 'ALERT');
    const filtered = filterProjectedAlerts(records, {
      status: statusFilter,
      severity: severityFilter,
    });
    const allOpenAndAck = filterProjectedAlerts(records, { status: '', severity: '' });
    return {
      items: filtered,
      summary: summarizeAlerts(allOpenAndAck),
    };
  }, [statusFilter, severityFilter, localReload]);

  const offlineNotifications = useLiveQuery(async () => {
    const db = getDb();
    const records = await listProjected<unknown>(db, 'comms', 'NOTIFICATION');
    return fromProjectedNotifications(records, unreadOnly);
  }, [unreadOnly, localReload]);

  const useOfflineAlerts = !online || alertsRead.failed || alertsRead.data === undefined;
  const alertItems: readonly AlertItem[] = useOfflineAlerts
    ? (offlineAlerts?.items ?? [])
    : (alertsRead.data?.items ?? []);
  const alertSummary: AlertSummary =
    !online || summaryRead.failed || summaryRead.data === undefined
      ? (offlineAlerts?.summary ?? {
          open: 0,
          acknowledged: 0,
          bySeverity: { INFO: 0, WARNING: 0, CRITICAL: 0 },
          truncated: false,
          computedAt: '',
        })
      : summaryRead.data;

  const useOfflineNotifs = !online || notifsRead.failed || notifsRead.data === undefined;
  const notifItems: readonly NotificationItem[] = useOfflineNotifs
    ? (offlineNotifications?.items ?? [])
    : (notifsRead.data?.items ?? []);
  const unreadCount = useOfflineNotifs
    ? (offlineNotifications?.unreadCount ?? 0)
    : (notifsRead.data?.unreadCount ?? 0);

  const tabs: readonly Tab[] = canManageRules
    ? ['alerts', 'notifications', 'rules']
    : ['alerts', 'notifications'];

  const handleAcknowledge = async (alertId: string, comment: string) => {
    if (!unlocked) return;
    const built = buildAlertAckPayload(comment);
    if (!built.ok) return;
    setSubmittingId(alertId);
    setLocalError(null);
    try {
      const sent = await submitCommand({
        authorUserId: unlocked.userId,
        commandType: built.commandType,
        aggregateType: 'ALERT',
        aggregateId: alertId,
        payload: built.payload,
      });
      setLastCmdId(sent.command_id);
      setActiveAction(null);
      setActionText('');
      setLocalReload((k) => k + 1);
    } catch (err) {
      setLocalError(saveErrorKey(err));
    } finally {
      setSubmittingId(null);
    }
  };

  const handleResolveOrDismiss = async (
    alertId: string,
    mode: 'RESOLVE' | 'DISMISS',
    text: string,
  ) => {
    const built =
      mode === 'RESOLVE' ? buildAlertResolvePayload(text) : buildAlertDismissPayload(text);
    if (!built.ok) return;
    setSubmittingId(alertId);
    try {
      const ok = await onlineCommands.send({
        commandType: built.commandType,
        aggregateType: 'ALERT',
        aggregateId: alertId,
        payload: built.payload,
      });
      if (ok) {
        setActiveAction(null);
        setActionText('');
      }
    } finally {
      setSubmittingId(null);
    }
  };

  const handleMarkNotificationRead = async (notificationId?: string) => {
    if (!unlocked) return;
    const built = buildNotificationReadPayload(
      notificationId ? { notificationIds: [notificationId] } : { all: true },
    );
    if (!built.ok) return;
    setSubmittingId(notificationId ?? 'ALL');
    setLocalError(null);
    try {
      const sent = await submitCommand({
        authorUserId: unlocked.userId,
        commandType: built.commandType,
        aggregateType: 'NOTIFICATION',
        aggregateId: notificationId ?? crypto.randomUUID(),
        payload: built.payload,
      });
      setLastCmdId(sent.command_id);
      setLocalReload((k) => k + 1);
    } catch (err) {
      setLocalError(saveErrorKey(err));
    } finally {
      setSubmittingId(null);
    }
  };

  const handleSaveRule = async (rule: AlertRuleItem) => {
    if (!editingRule || editingRule.alertType !== rule.alertType) return;
    const parsedHours = editingRule.escalationHours.trim()
      ? Number.parseInt(editingRule.escalationHours.trim(), 10)
      : null;
    const built = buildAlertRuleSetPayload({
      alertType: rule.alertType,
      enabled: editingRule.enabled,
      severity: editingRule.severity,
      ...(rule.escalationApplicable && (parsedHours === null || Number.isFinite(parsedHours))
        ? { escalationHours: parsedHours }
        : {}),
    });
    if (!built.ok) return;
    const ok = await onlineCommands.send({
      commandType: built.commandType,
      aggregateType: 'ALERT_RULE',
      aggregateId: crypto.randomUUID(),
      payload: built.payload,
    });
    if (ok) {
      setEditingRule(null);
    }
  };

  const activeCommandId = onlineCommands.last ?? lastCmdId;
  const activeError = onlineCommands.saveError ?? localError;

  return (
    <div className="comm-screen">
      <PageHeader
        title={t('nav.screens.alerts')}
        subtitle={t('comm.alerts.subtitle')}
        actions={
          <Button
            variant="tonal"
            size="sm"
            icon="sync"
            onClick={() => {
              alertsRead.retry();
              summaryRead.retry();
              notifsRead.retry();
              if (canManageRules) rulesRead.retry();
            }}
            disabled={!online || alertsRead.stale || notifsRead.stale}
          >
            {t('comm.refresh')}
          </Button>
        }
      />

      {!online ? <Banner tone="info">{t('comm.alerts.offlineBanner')}</Banner> : null}
      {activeError ? <Banner tone="bad">{t(activeError)}</Banner> : null}
      {activeCommandId ? (
        <CommandResult commandId={activeCommandId} messages="comm.result" />
      ) : null}

      <Tabs
        idPrefix="comm-alerts"
        label={t('nav.screens.alerts')}
        items={tabs.map((id) => ({
          id,
          label:
            id === 'notifications' && unreadCount > 0
              ? `${t(`comm.alerts.tab.${id}`)} (${unreadCount})`
              : t(`comm.alerts.tab.${id}`),
        }))}
        value={tab}
        onChange={setTab}
      />

      <TabPanel idPrefix="comm-alerts" id="alerts" active={tab === 'alerts'}>
        <div className="comm-summary-strip" aria-label={t('comm.alerts.summaryLabel')}>
          <div className="comm-summary-pill">
            <span className="comm-summary-pill__label">{t('comm.alerts.summaryOpen')}</span>
            <span className="comm-summary-pill__value">{alertSummary.open}</span>
          </div>
          <div className="comm-summary-pill">
            <span className="comm-summary-pill__label">{t('comm.alerts.summaryAcked')}</span>
            <span className="comm-summary-pill__value">{alertSummary.acknowledged}</span>
          </div>
          <div className="comm-summary-pill">
            <span className="comm-summary-pill__label">{t('comm.alerts.severity.CRITICAL')}</span>
            <span className="comm-summary-pill__value">{alertSummary.bySeverity.CRITICAL}</span>
          </div>
          <div className="comm-summary-pill">
            <span className="comm-summary-pill__label">{t('comm.alerts.severity.WARNING')}</span>
            <span className="comm-summary-pill__value">{alertSummary.bySeverity.WARNING}</span>
          </div>
        </div>

        <div className="comm-toolbar">
          <Field label={t('comm.alerts.filterStatus')}>
            {(control) => (
              <Select
                {...control}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as '' | AlertStatus)}
              >
                <option value="">{t('comm.alerts.allOption')}</option>
                {ALERT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`comm.alerts.status.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('comm.alerts.filterSeverity')}>
            {(control) => (
              <Select
                {...control}
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value as '' | AlertSeverity)}
              >
                <option value="">{t('comm.alerts.allOption')}</option>
                {ALERT_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {t(`comm.alerts.severity.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {online && alertsRead.data === undefined && !alertsRead.failed ? (
          <SkeletonRows rows={4} />
        ) : alertItems.length === 0 ? (
          <EmptyState icon="bell" title={t('comm.alerts.emptyTitle')}>
            {t('comm.alerts.emptyHint')}
          </EmptyState>
        ) : (
          <ul className="comm-list">
            {alertItems.map((alert) => {
              const actionRoute = routeOfActionScreen(alert.actionScreen);
              const isActionOpen = activeAction?.alertId === alert.id;
              const manualCloseAllowed = canManuallyCloseAlert(alert);
              return (
                <li
                  key={alert.id}
                  className={`comm-card${
                    alert.severity === 'CRITICAL'
                      ? ' comm-card--critical'
                      : alert.severity === 'WARNING'
                        ? ' comm-card--warning'
                        : ''
                  }`}
                >
                  <div className="comm-card__head">
                    <h2 className="comm-card__title">{alert.title}</h2>
                    <div className="comm-badges">
                      <Badge tone={severityBadgeTone(alert.severity)}>
                        {t(`comm.alerts.severity.${alert.severity}`)}
                      </Badge>
                      <Badge tone={statusBadgeTone(alert.status)}>
                        {t(`comm.alerts.status.${alert.status}`)}
                      </Badge>
                      <Badge tone="muted">{t(`comm.alerts.nature.${alert.nature}`)}</Badge>
                    </div>
                  </div>

                  {alert.message ? <p className="comm-card__body">{alert.message}</p> : null}

                  <div className="comm-card__meta">
                    <span>
                      {t('comm.alerts.typeLabel')} : {alert.alertType}
                    </span>
                    {alert.lastDetectedAt ? (
                      <span>{formatDateTime(alert.lastDetectedAt)}</span>
                    ) : null}
                  </div>

                  <div className="comm-card__actions">
                    {actionRoute ? (
                      <Link className="btn btn-outline btn-sm" to={actionRoute}>
                        {t('comm.alerts.openSourceScreen')}
                      </Link>
                    ) : null}

                    {alert.status === 'OPEN' ? (
                      <Button
                        variant="tonal"
                        size="sm"
                        disabled={submittingId === alert.id}
                        onClick={() => {
                          setActiveAction({ alertId: alert.id, mode: 'ACK' });
                          setActionText('');
                        }}
                      >
                        {t('comm.alerts.acknowledgeAction')}
                      </Button>
                    ) : null}

                    {manualCloseAllowed ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!online || submittingId === alert.id}
                          onClick={() => {
                            setActiveAction({ alertId: alert.id, mode: 'RESOLVE' });
                            setActionText('');
                          }}
                        >
                          {t('comm.alerts.resolveAction')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!online || submittingId === alert.id}
                          onClick={() => {
                            setActiveAction({ alertId: alert.id, mode: 'DISMISS' });
                            setActionText('');
                          }}
                        >
                          {t('comm.alerts.dismissAction')}
                        </Button>
                      </>
                    ) : null}
                  </div>

                  {isActionOpen && activeAction ? (
                    <div className="comm-form-panel">
                      <Field
                        label={
                          activeAction.mode === 'ACK'
                            ? t('comm.alerts.ackCommentLabel')
                            : activeAction.mode === 'RESOLVE'
                              ? t('comm.alerts.resolveCommentLabel')
                              : t('comm.alerts.dismissReasonLabel')
                        }
                      >
                        {(control) => (
                          <Textarea
                            {...control}
                            rows={2}
                            value={actionText}
                            onChange={(e) => setActionText(e.target.value)}
                          />
                        )}
                      </Field>
                      <div className="comm-inline-actions">
                        <Button
                          variant="tonal"
                          size="sm"
                          disabled={
                            submittingId === alert.id ||
                            (activeAction.mode !== 'ACK' && !actionText.trim())
                          }
                          onClick={() => {
                            if (activeAction.mode === 'ACK') {
                              void handleAcknowledge(alert.id, actionText);
                            } else {
                              void handleResolveOrDismiss(alert.id, activeAction.mode, actionText);
                            }
                          }}
                        >
                          {t('comm.alerts.confirmAction')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setActiveAction(null);
                            setActionText('');
                          }}
                        >
                          {t('comm.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </TabPanel>

      <TabPanel idPrefix="comm-alerts" id="notifications" active={tab === 'notifications'}>
        <div className="comm-toolbar">
          <Checkbox
            label={t('comm.notifications.unreadOnly')}
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />
          {unreadCount > 0 ? (
            <Button
              variant="tonal"
              size="sm"
              disabled={submittingId === 'ALL'}
              onClick={() => void handleMarkNotificationRead()}
            >
              {t('comm.notifications.markAllRead')}
            </Button>
          ) : null}
        </div>

        {online && notifsRead.data === undefined && !notifsRead.failed ? (
          <SkeletonRows rows={4} />
        ) : notifItems.length === 0 ? (
          <EmptyState icon="bell" title={t('comm.notifications.emptyTitle')}>
            {t('comm.notifications.emptyHint')}
          </EmptyState>
        ) : (
          <ul className="comm-list">
            {notifItems.map((notif) => {
              const targetRoute = routeOfNotification(notif);
              return (
                <li
                  key={notif.id}
                  className={`comm-card${!notif.readAt ? ' comm-card--unread' : ''}`}
                >
                  <div className="comm-card__head">
                    <h2 className="comm-card__title">{notif.title}</h2>
                    <div className="comm-badges">
                      <Badge tone={notif.readAt ? 'muted' : 'info'}>
                        {notif.readAt
                          ? t('comm.notifications.readBadge')
                          : t('comm.notifications.unreadBadge')}
                      </Badge>
                      <Badge tone="muted">{t(`comm.notifications.kind.${notif.kind}`)}</Badge>
                    </div>
                  </div>
                  {notif.body ? <p className="comm-card__body">{notif.body}</p> : null}
                  <div className="comm-card__meta">
                    {notif.createdAt ? <span>{formatDateTime(notif.createdAt)}</span> : null}
                  </div>
                  <div className="comm-card__actions">
                    {targetRoute ? (
                      <Link className="btn btn-outline btn-sm" to={targetRoute}>
                        {t('comm.notifications.openTarget')}
                      </Link>
                    ) : null}
                    {!notif.readAt ? (
                      <Button
                        variant="tonal"
                        size="sm"
                        disabled={submittingId === notif.id}
                        onClick={() => void handleMarkNotificationRead(notif.id)}
                      >
                        {t('comm.notifications.markRead')}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </TabPanel>

      {canManageRules ? (
        <TabPanel idPrefix="comm-alerts" id="rules" active={tab === 'rules'}>
          {!online ? (
            <Banner tone="warn">{t('comm.rules.onlineOnlyBanner')}</Banner>
          ) : rulesRead.data === undefined && !rulesRead.failed ? (
            <SkeletonRows rows={4} />
          ) : (
            <ul className="comm-list">
              {(rulesRead.data?.items ?? []).map((rule) => {
                const isEditing = editingRule?.alertType === rule.alertType;
                return (
                  <li key={rule.alertType} className="comm-card">
                    <div className="comm-card__head">
                      <h2 className="comm-card__title">{rule.alertType}</h2>
                      <div className="comm-badges">
                        <Badge tone={rule.enabled ? 'ok' : 'muted'}>
                          {rule.enabled ? t('comm.rules.enabled') : t('comm.rules.disabled')}
                        </Badge>
                        <Badge tone={severityBadgeTone(rule.severity)}>
                          {t(`comm.alerts.severity.${rule.severity}`)}
                        </Badge>
                        <Badge tone="muted">{t(`comm.alerts.nature.${rule.nature}`)}</Badge>
                      </div>
                    </div>

                    <div className="comm-card__meta">
                      <span>
                        {t('comm.rules.recipients')} : {rule.recipientRoles.join(', ')}
                      </span>
                      {rule.escalationApplicable && rule.escalationHours ? (
                        <span>
                          {t('comm.rules.escalationAfter', {
                            hours: rule.escalationHours,
                          })}
                        </span>
                      ) : null}
                    </div>

                    {isEditing && editingRule ? (
                      <div className="comm-form-panel">
                        <Switch
                          label={t('comm.rules.enableSwitch')}
                          checked={editingRule.enabled}
                          onChange={(e) =>
                            setEditingRule({ ...editingRule, enabled: e.target.checked })
                          }
                        />
                        <Field label={t('comm.rules.severityLabel')}>
                          {(control) => (
                            <Select
                              {...control}
                              value={editingRule.severity}
                              onChange={(e) =>
                                setEditingRule({
                                  ...editingRule,
                                  severity: e.target.value as AlertSeverity,
                                })
                              }
                            >
                              {rule.severitiesAdmitted.map((s) => (
                                <option key={s} value={s}>
                                  {t(`comm.alerts.severity.${s}`)}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                        {rule.escalationApplicable ? (
                          <Field label={t('comm.rules.escalationHoursLabel')}>
                            {(control) => (
                              <Input
                                {...control}
                                type="number"
                                min={1}
                                max={168}
                                value={editingRule.escalationHours}
                                onChange={(e) =>
                                  setEditingRule({
                                    ...editingRule,
                                    escalationHours: e.target.value,
                                  })
                                }
                              />
                            )}
                          </Field>
                        ) : null}
                        <div className="comm-inline-actions">
                          <Button
                            variant="tonal"
                            size="sm"
                            disabled={onlineCommands.blocked}
                            onClick={() => void handleSaveRule(rule)}
                          >
                            {t('comm.rules.saveAction')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setEditingRule(null)}>
                            {t('comm.cancel')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="comm-card__actions">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setEditingRule({
                              alertType: rule.alertType,
                              enabled: rule.enabled,
                              severity: rule.severity,
                              escalationHours:
                                rule.escalationHours !== null ? String(rule.escalationHours) : '',
                            })
                          }
                        >
                          {t('comm.rules.editAction')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </TabPanel>
      ) : null}
    </div>
  );
}
