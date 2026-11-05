/**
 * Onglet « Équipes » de l'écran Organisation (ECR-ADM-06 ; UC-ADM-03 ; S-28) : équipes avec leur responsable et
 * leurs membres, création, ajout et retrait d'un membre. Une personne n'est membre que d'une équipe à la fois :
 * l'ajouter à une autre l'y déplace (le serveur ferme l'appartenance précédente). Une équipe se ferme (AV-515) :
 * ses membres la quittent et elle n'en reçoit plus ; elle ne se renomme pas (AV-497).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, EmptyState, Field, Input, Select } from '../../components/ui/index.js';
import { idGenerator } from '../../platform/composition.js';
import { formatBusinessDate } from '../home/format-home.js';
import {
  EMPTY_TEAM_FORM,
  LIMITS,
  TEAM_CLOSE_REASON_MAX,
  teamAssignCommand,
  teamCloseCommand,
  teamCreateCommand,
  teamOfUser,
  teamProblems,
  teamRemoveCommand,
  type TeamForm,
  type TeamView,
} from './organization.js';
import { panelBlocked, type PanelProps } from './panel-props.js';

export function TeamsPanel(props: PanelProps) {
  const { t } = useTranslation();
  const { data, commands } = props;
  const blocked = panelBlocked(props);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<TeamForm>(EMPTY_TEAM_FORM);
  const [adding, setAdding] = useState<{ teamId: string; userId: string } | null>(null);
  const [closing, setClosing] = useState<{ teamId: string; reason: string } | null>(null);
  const problems = teamProblems(form);

  const closeTeam = async (team: TeamView) => {
    if (!closing) return;
    if (await commands.send(teamCloseCommand(team, closing.reason), blocked)) setClosing(null);
  };

  const create = async () => {
    const sent = await commands.send(teamCreateCommand(form, idGenerator.newId()), blocked);
    if (sent) {
      setCreating(false);
      setForm(EMPTY_TEAM_FORM);
    }
  };

  const assign = async () => {
    if (!adding || !adding.userId) return;
    const sent = await commands.send(
      teamAssignCommand(adding.teamId, adding.userId, idGenerator.newId()),
      blocked,
    );
    if (sent) setAdding(null);
  };

  const remove = (userId: string) =>
    void commands.send(teamRemoveCommand(userId, idGenerator.newId()), blocked);

  const moveFrom = (team: TeamView): TeamView | undefined =>
    adding && adding.teamId === team.id && adding.userId
      ? teamOfUser(data.teams, adding.userId)
      : undefined;

  return (
    <>
      {!creating ? (
        <div className="adm-actions org-toolbar">
          <Button
            variant="tonal"
            icon="plus"
            disabled={blocked || data.users.length === 0}
            onClick={() => setCreating(true)}
          >
            {t('org.teams.new')}
          </Button>
        </div>
      ) : (
        <div className="card adm-create" role="group" aria-label={t('org.teams.new')}>
          <h2>{t('org.teams.new')}</h2>
          <div className="adm-form">
            <Field label={t('org.field.code')} hint={t('org.hint.code', { max: LIMITS.teamCode })}>
              {(control) => (
                <Input
                  {...control}
                  maxLength={LIMITS.teamCode}
                  autoCapitalize="characters"
                  value={form.code}
                  onChange={(event) => setForm({ ...form, code: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('org.field.name')}>
              {(control) => (
                <Input
                  {...control}
                  maxLength={LIMITS.name}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('org.field.manager')} hint={t('org.hint.manager')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.managerUserId}
                  onChange={(event) => setForm({ ...form, managerUserId: event.target.value })}
                >
                  <option value="">{t('org.choose')}</option>
                  {data.users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="adm-actions">
              <Button disabled={blocked || problems.length > 0} onClick={() => void create()}>
                {t('org.teams.create_confirm')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setForm(EMPTY_TEAM_FORM);
                }}
              >
                {t('org.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {data.teams.length === 0 ? (
        <EmptyState icon="users" title={t('org.teams.empty')} />
      ) : (
        <ul className="adm-cards">
          {data.teams.map((team) => {
            const from = moveFrom(team);
            const candidates = data.users.filter(
              (user) => !team.members.some((member) => member.userId === user.id),
            );
            return (
              <li
                key={team.id}
                className="line-card"
                aria-label={t('org.teams.card', { name: team.name })}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <strong>{team.name}</strong>
                    <span className="adm-sub">
                      {[
                        team.code,
                        t('org.teams.manager', { name: team.managerName ?? t('org.unknown_user') }),
                        t('org.teams.members_count', { count: team.members.length }),
                      ].join(' · ')}
                    </span>
                  </span>
                  {!team.isActive ? <Badge tone="muted">{t('org.teams.inactive')}</Badge> : null}
                </div>
                {team.members.length > 0 ? (
                  <ul
                    className="adm-roles"
                    aria-label={t('org.teams.members', { name: team.name })}
                  >
                    {team.members.map((member) => (
                      <li key={member.membershipId}>
                        <span className="adm-card-title">
                          <strong>{member.fullName ?? t('org.unknown_user')}</strong>
                          <span className="adm-sub">
                            {t('org.teams.since', {
                              date: formatBusinessDate(member.since.slice(0, 10)),
                            })}
                          </span>
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={blocked}
                          aria-label={t('org.teams.remove', {
                            name: member.fullName ?? t('org.unknown_user'),
                            team: team.name,
                          })}
                          onClick={() => remove(member.userId)}
                        >
                          {t('org.teams.remove_short')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="adm-note">{t('org.teams.no_members')}</p>
                )}
                {adding?.teamId === team.id ? (
                  <div className="adm-form adm-panel">
                    <Field label={t('org.teams.add_label')}>
                      {(control) => (
                        <Select
                          {...control}
                          value={adding.userId}
                          onChange={(event) => setAdding({ ...adding, userId: event.target.value })}
                        >
                          <option value="">{t('org.choose')}</option>
                          {candidates.map((user) => (
                            <option key={user.id} value={user.id}>
                              {user.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {from ? (
                      <p className="adm-note is-warn">
                        {t('org.teams.move_warning', { team: from.name })}
                      </p>
                    ) : null}
                    <div className="adm-actions">
                      <Button disabled={blocked || !adding.userId} onClick={() => void assign()}>
                        {t('org.teams.add_confirm', { name: team.name })}
                      </Button>
                      <Button variant="ghost" onClick={() => setAdding(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : closing?.teamId === team.id ? (
                  <div className="adm-form adm-panel">
                    <p className="adm-note is-warn">
                      {team.members.length === 0
                        ? t('org.teams.close_warning_none')
                        : t('org.teams.close_warning', { count: team.members.length })}
                    </p>
                    <Field label={t('org.teams.close_reason')}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={TEAM_CLOSE_REASON_MAX}
                          value={closing.reason}
                          onChange={(event) =>
                            setClosing({ ...closing, reason: event.target.value })
                          }
                        />
                      )}
                    </Field>
                    <div className="adm-actions">
                      <Button disabled={blocked} onClick={() => void closeTeam(team)}>
                        {t('org.teams.close_confirm', { name: team.name })}
                      </Button>
                      <Button variant="ghost" onClick={() => setClosing(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="adm-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked || candidates.length === 0 || !team.isActive}
                      onClick={() => setAdding({ teamId: team.id, userId: '' })}
                    >
                      {t('org.teams.add')}
                    </Button>
                    {team.isActive ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={blocked}
                        aria-label={t('org.teams.close_open', { name: team.name })}
                        onClick={() => setClosing({ teamId: team.id, reason: '' })}
                      >
                        {t('org.teams.close')}
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
