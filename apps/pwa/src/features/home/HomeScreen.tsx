/**
 * ECR-ADM-03 « Accueil par rôle » (UX-01 ; ADR-030, ADR-049) : la page de référence de chaque
 * utilisateur. D'abord ce qui demande une réaction (signaux, triés par gravité), puis les actions du
 * jour, les indicateurs et l'activité récente du rôle affiché. Un compte qui cumule plusieurs rôles les
 * choisit par un sélecteur : un rôle à la fois, sans indicateur répété. Tout vient de
 * `GET /api/v1/home`, calculé par le serveur dans le périmètre du rôle (BR-ANA-001) ; l'écran
 * n'invente aucun chiffre.
 *
 * Une action sans écran (`route` nulle) reste visible mais désactivée, marquée « Bientôt » : on
 * n'affiche jamais un bouton qui ne fait rien en prétendant le contraire (ADR-030 §8).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  HomeAction,
  HomeActivity,
  HomeKpi,
  HomeResponse,
  HomeSection,
  HomeSignal,
} from '@gic/contracts';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Icon,
  KpiTile,
  LinkButton,
  List,
  ListRow,
  Section,
  SkeletonRows,
  TabPanel,
  Tabs,
  cx,
  type Tone,
} from '../../components/ui/index.js';
import { formatBusinessDay, formatClockTime, formatKpiValue, formatMoment } from './format-home.js';
import { useHome, type HomeError } from './useHome.js';
import { ROUTES, routeOfAction, routeOfSignal } from '../../app/screens.js';
import { iconOfAction } from '../shell/nav-config.js';

const ARROWS = { up: '▲', down: '▼', flat: '■' } as const;
const KPI_TONE = { neutral: 'neutral', good: 'neutral', warn: 'warn', bad: 'bad' } as const;
const DELTA_TONE = { good: 'ok', warn: 'warn', bad: 'bad', neutral: 'neutral' } as const;
const SIGNAL_TONE: Record<string, Tone> = { critical: 'bad', warning: 'warn', info: 'info' };

/** Rôle affiché, mémorisé le temps de la session (sans stockage : le premier rôle s'affiche). */
const ROLE_KEY = 'gic.home.role';

function readPickedRole(): string | null {
  try {
    return window.sessionStorage.getItem(ROLE_KEY);
  } catch {
    return null;
  }
}

function rememberPickedRole(role: string): void {
  try {
    window.sessionStorage.setItem(ROLE_KEY, role);
  } catch {
    // Pas de stockage : le choix vaut pour cet affichage seulement.
  }
}

function KpiCard({ kpi }: { readonly kpi: HomeKpi }) {
  const { t } = useTranslation();
  const series = kpi.series && kpi.series.length >= 2 ? kpi.series : null;
  return (
    <KpiTile
      data-kpi={kpi.code}
      label={kpi.label}
      value={formatKpiValue(kpi.value, kpi.unit)}
      tone={KPI_TONE[kpi.tone]}
      {...(kpi.detail ? { detail: kpi.detail } : {})}
      {...(kpi.delta
        ? {
            delta: {
              text: (
                <>
                  <span aria-hidden="true">{ARROWS[kpi.delta.direction]}</span> {kpi.delta.label}
                </>
              ),
              tone: DELTA_TONE[kpi.delta.tone],
            },
          }
        : {})}
      {...(series
        ? {
            spark: series.map((point) => point.value),
            sparkLabel: t('home.spark_label', { count: series.length }),
          }
        : {})}
    />
  );
}

function ActionButton({ action, role }: { readonly action: HomeAction; readonly role: string }) {
  const { t } = useTranslation();
  const className = cx('action', action.primary && 'action-primary');
  const route = routeOfAction(action, role);
  const body = (
    <>
      <Icon name={iconOfAction(action.code)} size={20} className="action-icon" />
      <span className="action-text">
        <span className="action-label">{action.label}</span>
        {action.hint ? <span className="action-hint">{action.hint}</span> : null}
      </span>
    </>
  );
  if (route) {
    return (
      <Link to={route} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" className={`${className} action-soon`} disabled aria-disabled="true">
      {body}
      <span className="action-soon-tag">{t('home.soon')}</span>
    </button>
  );
}

function SignalItem({ signal }: { readonly signal: HomeSignal }) {
  const { t } = useTranslation();
  const severity = signal.severity.toLowerCase();
  const tone = SIGNAL_TONE[severity] ?? 'info';
  const route = routeOfSignal(signal);
  return (
    <li className="signal" data-signal={signal.code}>
      <span className={cx('list-lead', `is-${tone}`)}>
        <Icon name={severity === 'info' ? 'info' : 'alert'} size={20} />
      </span>
      <div className="signal-body">
        <p className="signal-title">{signal.title}</p>
        {signal.detail ? <p className="signal-detail">{signal.detail}</p> : null}
        {signal.action ? (
          route ? (
            <Link to={route} className="signal-action">
              {signal.action.label}
              <Icon name="arrow-right" size={16} />
            </Link>
          ) : (
            <span className="signal-action signal-action-soon">
              {signal.action.label} · {t('home.soon').toLowerCase()}
            </span>
          )
        ) : null}
      </div>
      <Badge tone={tone}>{t(`home.severity_${severity}`)}</Badge>
    </li>
  );
}

function ActivityList({
  activity,
  today,
}: {
  readonly activity: HomeActivity;
  readonly today: string;
}) {
  const { t } = useTranslation();
  return (
    <Section title={activity.title} headingLevel="h3">
      {activity.items.length === 0 ? (
        <p className="muted">{t('home.activity_empty')}</p>
      ) : (
        <List>
          {activity.items.map((item) => (
            <ListRow
              key={item.id}
              className={item.tone === 'bad' ? 'is-bad' : undefined}
              leading={
                <time className="activity-time" dateTime={item.at}>
                  {formatMoment(item.at, today)}
                </time>
              }
              title={item.label}
              subtitle={item.detail ?? undefined}
              value={item.amountXaf !== null ? formatKpiValue(item.amountXaf, 'XAF') : undefined}
            />
          ))}
        </List>
      )}
    </Section>
  );
}

function RoleSection({
  section,
  today,
  compact,
}: {
  readonly section: HomeSection;
  readonly today: string;
  /** Rôle choisi par le sélecteur : le titre reste pour les lecteurs d'écran seulement. */
  readonly compact: boolean;
}) {
  const { t } = useTranslation();
  const headingId = `home-role-${section.role}`;
  // La principale d'abord, celles qui n'ont pas encore d'écran en dernier.
  const ranked = section.actions
    .map((action, index) => ({
      action,
      index,
      soon: routeOfAction(action, section.role) === null,
    }))
    .sort(
      (a, b) =>
        Number(a.soon) - Number(b.soon) ||
        Number(b.action.primary) - Number(a.action.primary) ||
        a.index - b.index,
    );
  return (
    <section className="home-role" aria-labelledby={headingId}>
      <header className="home-role-head">
        <h2 id={headingId} className={cx(compact && 'visually-hidden')}>
          {section.roleLabel}
        </h2>
        <span className="home-scope">{section.scopeLabel}</span>
      </header>
      {section.actions.length > 0 ? (
        <div className="home-actions" role="group" aria-label={t('home.actions_title')}>
          {ranked.map(({ action }) => (
            <ActionButton key={action.code} action={action} role={section.role} />
          ))}
        </div>
      ) : null}
      {section.kpis.length > 0 ? (
        <div className="home-kpis" role="group" aria-label={t('home.kpis_title')}>
          {section.kpis.map((kpi) => (
            <KpiCard key={kpi.code} kpi={kpi} />
          ))}
        </div>
      ) : null}
      {section.activity.map((activity) => (
        <ActivityList key={activity.code} activity={activity} today={today} />
      ))}
    </section>
  );
}

function Greeting({ data }: { readonly data: HomeResponse }) {
  const { t } = useTranslation();
  const day = formatBusinessDay(data.businessDay);
  return (
    <div>
      <p className="home-date">{day.charAt(0).toUpperCase() + day.slice(1)}</p>
      <h1>{t('home.greeting', { name: data.user.fullName })}</h1>
    </div>
  );
}

interface HomeContentProps {
  readonly data: HomeResponse;
  readonly loading: boolean;
  readonly error: HomeError | undefined;
  readonly refresh: () => void;
}

function HomeContent({ data, loading, error, refresh }: HomeContentProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | null>(readPickedRole);
  const time = formatClockTime(data.generatedAt);
  const current = data.sections.find((section) => section.role === picked) ?? data.sections[0];

  return (
    <section className="home" aria-busy={loading}>
      <header className="home-head">
        <Greeting data={data} />
        <div className="home-fresh">
          <span>{t('home.updated_at', { time })}</span>
          <Button variant="ghost" size="sm" icon="sync" onClick={refresh} disabled={loading}>
            {loading ? t('home.refreshing') : t('home.refresh')}
          </Button>
        </div>
      </header>

      {error ? (
        <Banner tone="warn" role="status">
          {t(error === 'OFFLINE' ? 'home.banner_offline' : 'home.banner_stale', { time })}
        </Banner>
      ) : null}

      {!current ? (
        <EmptyState icon="shield" title={t('home.no_roles_title')}>
          {t('home.no_roles')}
        </EmptyState>
      ) : (
        <>
          <Section title={t('home.signals_title')}>
            {data.signals.length === 0 ? (
              <p className="home-calm">
                <Icon name="check-circle" size={18} /> {t('home.signals_none')}
              </p>
            ) : (
              <List className="signal-list">
                {data.signals.map((signal) => (
                  <SignalItem key={`${signal.code}-${signal.title}`} signal={signal} />
                ))}
              </List>
            )}
          </Section>
          {data.sections.length > 1 ? (
            <div className="home-roles">
              <Tabs
                label={t('home.role_picker')}
                idPrefix="home-role"
                value={current.role}
                onChange={(role) => {
                  setPicked(role);
                  rememberPickedRole(role);
                }}
                items={data.sections.map((section) => ({
                  id: section.role,
                  label: section.roleLabel,
                }))}
              />
              <TabPanel idPrefix="home-role" id={current.role} active>
                <RoleSection section={current} today={data.businessDay} compact />
              </TabPanel>
            </div>
          ) : (
            <RoleSection section={current} today={data.businessDay} compact={false} />
          )}
        </>
      )}
    </section>
  );
}

export function HomeScreen() {
  const { t } = useTranslation();
  const { data, loading, error, refresh } = useHome();

  if (!data) {
    if (loading) {
      return (
        <section className="home" aria-busy="true">
          <h1>{t('home.title')}</h1>
          <p className="muted">{t('home.loading')}</p>
          <SkeletonRows rows={4} />
        </section>
      );
    }
    return (
      <section className="home">
        <h1>{t('home.title')}</h1>
        <Banner tone="bad">{t(`home.error_${(error ?? 'SERVER_ERROR').toLowerCase()}`)}</Banner>
        <div className="home-error-actions">
          <Button onClick={refresh}>{t('home.retry')}</Button>
          <LinkButton to={ROUTES.menu} variant="outline">
            {t('nav.open_menu')}
          </LinkButton>
          <p className="muted">{t('nav.offline_menu_hint')}</p>
        </div>
      </section>
    );
  }

  return <HomeContent data={data} loading={loading} error={error} refresh={refresh} />;
}
