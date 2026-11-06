/**
 * ECR-HLP-01 « Guide et aide » (AV-525, ADR-058) : le guide complet de l'application, construit sur l'appareil à
 * partir du même contenu que l'aide de chaque page (`content/`) et des droits du profil connecté. Quatre blocs :
 * le profil (ses rôles et les pages qui lui sont proposées), les parcours de bout en bout (ceux de son rôle en
 * premier), toutes les pages par domaine (celles qu'il ne peut pas ouvrir disent quel rôle le peut) et les
 * questions fréquentes. Une recherche filtre l'ensemble. Statique et local : il s'ouvre hors ligne.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Field, Icon, Input, PageHeader } from '../../components/ui/index.js';
import { SCREEN_GROUPS, SCREENS, type ScreenGroup } from '../../app/screens.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { FAQ, JOURNEYS, SCREEN_HELP } from './content/index.js';
import { canDo, journeysFor, normalize, rolesOfScreen } from './help-logic.js';
import { roleLabel, type Journey, type ScreenHelp } from './help-types.js';
import { ActionLine } from './ActionLine.js';
import './help.css';

const matches = (query: string, ...parts: readonly (string | undefined)[]): boolean =>
  query === '' || parts.some((part) => part !== undefined && normalize(part).includes(query));

function pageMatches(query: string, help: ScreenHelp): boolean {
  return matches(
    query,
    help.title,
    help.purpose,
    ...help.actions.flatMap((action) => [action.label, action.what]),
  );
}

function journeyMatches(query: string, journey: Journey): boolean {
  return matches(
    query,
    journey.title,
    journey.goal,
    ...journey.steps.flatMap((step) => [step.label, step.what]),
  );
}

function JourneyCard({
  journey,
  held,
}: {
  readonly journey: Journey;
  readonly held: readonly string[];
}) {
  const { t } = useTranslation();
  const screenRoles = (to: string) => SCREENS.find((screen) => screen.path === to)?.roles ?? 'ALL';
  return (
    <details className="guide-card">
      <summary>
        <span>{journey.title}</span>
        <Icon name="chevron-down" size={18} />
      </summary>
      <div className="guide-card-body">
        <p className="guide-lead">{journey.goal}</p>
        <ol className="guide-steps">
          {journey.steps.map((step) => {
            const allowed = step.roles ?? screenRoles(step.to);
            const mine = canDo(allowed, held);
            return (
              <li key={step.label + step.to}>
                <strong>{step.label}</strong>
                <span>{step.what}</span>
                <span className="guide-step-who">
                  {allowed === 'ALL'
                    ? t('help.guide.everyone')
                    : t('help.roles', { roles: allowed.map(roleLabel).join(', ') })}
                </span>
                {mine ? (
                  <Link className="help-link" to={step.to}>
                    {t('help.go')}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </details>
  );
}

function PageCard({ help, held }: { readonly help: ScreenHelp; readonly held: readonly string[] }) {
  const { t } = useTranslation();
  const roles = rolesOfScreen(help);
  const accessible = canDo(roles, held);
  const linkable = accessible && !help.path.includes(':');
  return (
    <li className={`guide-page${accessible ? '' : ' is-reserved'}`}>
      <details>
        <summary className="guide-page-head">
          <strong>{help.title}</strong>
          {!accessible ? <Badge tone="muted">{t('help.guide.reserved')}</Badge> : null}
        </summary>
        <div className="guide-card-body">
          <p>{help.purpose}</p>
          {help.before && help.before.length > 0 ? (
            <ul className="help-list">
              {help.before.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <ul className="help-actions">
            {help.actions.map((action) => (
              <ActionLine key={action.label} action={action} />
            ))}
          </ul>
          <span className="guide-page-roles">
            {roles === 'ALL'
              ? t('help.guide.everyone')
              : t('help.roles', { roles: roles.map(roleLabel).join(', ') })}
          </span>
          {linkable ? (
            <Link className="help-link" to={help.path}>
              {t('help.guide.open_page')}
            </Link>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function GuideScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const held = useMemo(() => (navigation ? navigation.roles : []), [navigation]);
  const [text, setText] = useState('');
  const query = normalize(text.trim());

  const { mine, others } = journeysFor(JOURNEYS, held);
  const journeys = [...mine, ...others].filter((journey) => journeyMatches(query, journey));
  const questions = FAQ.filter((item) => matches(query, item.question, item.answer));

  // Pages du registre par domaine, puis les pages de détail (sans entrée propre au registre).
  const byGroup = SCREEN_GROUPS.map((group: ScreenGroup) => ({
    group,
    pages: SCREEN_HELP.filter(
      (help) =>
        SCREENS.find((screen) => screen.path === help.path)?.group === group &&
        pageMatches(query, help),
    ),
  })).filter(({ pages }) => pages.length > 0);
  const detailPages = SCREEN_HELP.filter(
    (help) => !SCREENS.some((screen) => screen.path === help.path) && pageMatches(query, help),
  );

  return (
    <section className="sale guide">
      <PageHeader title={t('nav.screens.help')} />
      <Field label={t('help.guide.search_label')} className="guide-search">
        {(control) => (
          <Input
            {...control}
            type="search"
            value={text}
            placeholder={t('help.guide.search_placeholder')}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>

      <section className="guide-block" aria-labelledby="guide-profile">
        <h2 id="guide-profile">{t('help.guide.profile')}</h2>
        {held.length === 0 ? (
          <p className="guide-lead">{t('help.guide.profile_unknown')}</p>
        ) : (
          <p className="guide-lead">
            {t('help.guide.profile_roles', { roles: held.map(roleLabel).join(', ') })}
          </p>
        )}
        <p className="guide-lead">{t('help.guide.profile_hint')}</p>
      </section>

      {journeys.length > 0 ? (
        <section className="guide-block" aria-labelledby="guide-journeys">
          <h2 id="guide-journeys">{t('help.guide.journeys')}</h2>
          <p className="guide-lead">{t('help.guide.journeys_hint')}</p>
          {journeys.map((journey) => (
            <JourneyCard key={journey.id} journey={journey} held={held} />
          ))}
        </section>
      ) : null}

      {byGroup.length > 0 || detailPages.length > 0 ? (
        <section className="guide-block" aria-labelledby="guide-pages">
          <h2 id="guide-pages">{t('help.guide.pages')}</h2>
          <p className="guide-lead">{t('help.guide.pages_hint')}</p>
          {byGroup.map(({ group, pages }) => (
            <div key={group} className="guide-block">
              <h3>{t(`nav.groups.${group}`)}</h3>
              <ul className="guide-pages">
                {pages.map((help) => (
                  <PageCard key={help.path} help={help} held={held} />
                ))}
              </ul>
            </div>
          ))}
          {detailPages.length > 0 ? (
            <div className="guide-block">
              <h3>{t('help.guide.detail_pages')}</h3>
              <ul className="guide-pages">
                {detailPages.map((help) => (
                  <PageCard key={help.path} help={help} held={held} />
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {questions.length > 0 ? (
        <section className="guide-block" aria-labelledby="guide-faq">
          <h2 id="guide-faq">{t('help.guide.faq')}</h2>
          {questions.map((item) => (
            <details key={item.question} className="guide-card">
              <summary>
                <span>{item.question}</span>
                <Icon name="chevron-down" size={18} />
              </summary>
              <div className="guide-card-body">
                <p>{item.answer}</p>
              </div>
            </details>
          ))}
        </section>
      ) : null}

      {journeys.length === 0 &&
      byGroup.length === 0 &&
      detailPages.length === 0 &&
      questions.length === 0 ? (
        <p className="guide-lead">{t('help.guide.nothing')}</p>
      ) : null}
    </section>
  );
}
