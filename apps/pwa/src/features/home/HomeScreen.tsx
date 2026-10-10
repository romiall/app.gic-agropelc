/**
 * ECR-ADM-03 « Accueil par rôle » (UX-01 ; ADR-030) : la page de référence de chaque utilisateur.
 * D'abord ce qui demande une réaction (signaux, triés par gravité), puis, pour chacun de ses rôles,
 * les actions du jour, les indicateurs et l'activité récente. Tout vient de `GET /api/v1/home`,
 * calculé par le serveur dans le périmètre du rôle (BR-ANA-001) ; l'écran n'invente aucun chiffre.
 *
 * Une action sans écran (`route` nulle) reste visible mais désactivée, marquée « Bientôt » : on
 * n'affiche jamais un bouton qui ne fait rien en prétendant le contraire (ADR-030 §8).
 */
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
  formatBusinessDay,
  formatClockTime,
  formatKpiValue,
  formatMoment,
  sparklinePoints,
} from './format-home.js';
import { useHome } from './useHome.js';
import { ROUTES, routeOfAction } from '../../app/screens.js';

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 28;

function Sparkline({ kpi }: { readonly kpi: HomeKpi }) {
  const { t } = useTranslation();
  if (!kpi.series || kpi.series.length < 2) return null;
  const points = sparklinePoints(
    kpi.series.map((point) => point.value),
    SPARK_WIDTH,
    SPARK_HEIGHT,
  );
  const last = points.split(' ').at(-1)?.split(',') ?? [];
  return (
    <svg
      className="kpi-spark"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      role="img"
      aria-label={t('home.spark_label', { count: kpi.series.length })}
      preserveAspectRatio="none"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
      {last.length === 2 ? <circle cx={last[0]} cy={last[1]} r="2.5" fill="currentColor" /> : null}
    </svg>
  );
}

const ARROWS = { up: '▲', down: '▼', flat: '■' } as const;

function KpiCard({ kpi }: { readonly kpi: HomeKpi }) {
  return (
    <article className={`kpi kpi-${kpi.tone}`} data-kpi={kpi.code}>
      <h4 className="kpi-label">{kpi.label}</h4>
      <p className="kpi-value">{formatKpiValue(kpi.value, kpi.unit)}</p>
      {kpi.detail ? <p className="kpi-detail">{kpi.detail}</p> : null}
      {kpi.delta ? (
        <p className={`kpi-delta kpi-delta-${kpi.delta.tone}`}>
          <span aria-hidden="true">{ARROWS[kpi.delta.direction]}</span> {kpi.delta.label}
        </p>
      ) : null}
      <Sparkline kpi={kpi} />
    </article>
  );
}

function ActionButton({ action }: { readonly action: HomeAction }) {
  const { t } = useTranslation();
  const className = `action${action.primary ? ' action-primary' : ''}`;
  const route = routeOfAction(action);
  const body = (
    <>
      <span className="action-label">{action.label}</span>
      {action.hint ? <span className="action-hint">{action.hint}</span> : null}
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
  return (
    <li className={`signal signal-${severity}`} data-signal={signal.code}>
      <span className="signal-badge">{t(`home.severity_${severity}`)}</span>
      <div className="signal-body">
        <p className="signal-title">{signal.title}</p>
        {signal.detail ? <p className="signal-detail">{signal.detail}</p> : null}
      </div>
      {signal.action ? (
        signal.action.route ? (
          <Link to={signal.action.route} className="signal-action">
            {signal.action.label}
          </Link>
        ) : (
          <span className="signal-action signal-action-soon">
            {signal.action.label} · {t('home.soon').toLowerCase()}
          </span>
        )
      ) : null}
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
    <section className="home-activity" aria-label={activity.title}>
      <h4>{activity.title}</h4>
      {activity.items.length === 0 ? (
        <p className="home-muted">{t('home.activity_empty')}</p>
      ) : (
        <ul>
          {activity.items.map((item) => (
            <li key={item.id} className={`activity-${item.tone}`}>
              <time dateTime={item.at}>{formatMoment(item.at, today)}</time>
              <span className="activity-label">
                {item.label}
                {item.detail ? <small> · {item.detail}</small> : null}
              </span>
              {item.amountXaf !== null ? (
                <span className="activity-amount">{formatKpiValue(item.amountXaf, 'XAF')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RoleSection({
  section,
  today,
}: {
  readonly section: HomeSection;
  readonly today: string;
}) {
  const { t } = useTranslation();
  const headingId = `home-role-${section.role}`;
  return (
    <section className="home-role" aria-labelledby={headingId}>
      <header className="home-role-head">
        <h2 id={headingId}>{section.roleLabel}</h2>
        <span className="home-scope">{section.scopeLabel}</span>
      </header>
      {section.actions.length > 0 ? (
        <div className="home-actions" role="group" aria-label={t('home.actions_title')}>
          {section.actions.map((action) => (
            <ActionButton key={action.code} action={action} />
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

export function HomeScreen() {
  const { t } = useTranslation();
  const { data, loading, error, refresh } = useHome();

  if (!data) {
    if (loading) {
      return (
        <section className="home" aria-busy="true">
          <h1>{t('home.title')}</h1>
          <p className="home-muted">{t('home.loading')}</p>
        </section>
      );
    }
    return (
      <section className="home">
        <h1>{t('home.title')}</h1>
        <div role="alert" className="alert alert-error">
          {t(`home.error_${(error ?? 'SERVER_ERROR').toLowerCase()}`)}
        </div>
        <div className="home-error-actions">
          <button type="button" onClick={refresh}>
            {t('home.retry')}
          </button>
          <Link to={ROUTES.menu} className="action">
            <span className="action-label">{t('nav.open_menu')}</span>
            <span className="action-hint">{t('nav.offline_menu_hint')}</span>
          </Link>
        </div>
      </section>
    );
  }

  const time = formatClockTime(data.generatedAt);
  return (
    <section className="home" aria-busy={loading}>
      <header className="home-head">
        <Greeting data={data} />
        <div className="home-fresh">
          <span>{t('home.updated_at', { time })}</span>
          <button type="button" className="secondary" onClick={refresh} disabled={loading}>
            {loading ? t('home.refreshing') : t('home.refresh')}
          </button>
        </div>
      </header>

      {error ? (
        <div role="status" className="home-banner">
          {t(error === 'OFFLINE' ? 'home.banner_offline' : 'home.banner_stale', { time })}
        </div>
      ) : null}

      {data.sections.length === 0 ? (
        <p className="home-muted">{t('home.no_roles')}</p>
      ) : (
        <>
          <section className="home-signals" aria-labelledby="home-signals-title">
            <h2 id="home-signals-title">{t('home.signals_title')}</h2>
            {data.signals.length === 0 ? (
              <p className="home-calm">{t('home.signals_none')}</p>
            ) : (
              <ul>
                {data.signals.map((signal) => (
                  <SignalItem key={`${signal.code}-${signal.title}`} signal={signal} />
                ))}
              </ul>
            )}
          </section>
          {data.sections.map((section) => (
            <RoleSection key={section.role} section={section} today={data.businessDay} />
          ))}
        </>
      )}
    </section>
  );
}
