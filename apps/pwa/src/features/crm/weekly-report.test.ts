import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import {
  EMPTY_REPORT_DRAFT,
  currentWeek,
  draftFingerprint,
  draftFromReport,
  hasUnsentReport,
  isDraftReady,
  nextWeek,
  pendingReportDraft,
  previousWeek,
  reportPayload,
  weeklyReportId,
  type ServerWeeklyReport,
} from './weekly-report.js';

const USER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

describe('semaine du bilan', () => {
  it('lundi de la semaine en cours, semaines voisines', () => {
    expect(currentWeek('2026-11-04')).toBe('2026-11-02');
    expect(currentWeek('2026-11-08')).toBe('2026-11-02');
    expect(previousWeek('2026-11-02')).toBe('2026-10-26');
    expect(nextWeek('2026-10-26')).toBe('2026-11-02');
  });
});

describe('identifiant du bilan', () => {
  it('stable pour un commercial et une semaine, distinct sinon : renvoyer le bilan le corrige', async () => {
    const a = await weeklyReportId(USER, '2026-11-02');
    expect(a).toBe(await weeklyReportId(USER, '2026-11-02'));
    expect(a).not.toBe(await weeklyReportId(USER, '2026-11-09'));
    expect(a).not.toBe(await weeklyReportId(OTHER, '2026-11-02'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('contenu du bilan', () => {
  it('prêt dès qu’une rubrique dit quelque chose', () => {
    expect(isDraftReady(EMPTY_REPORT_DRAFT)).toBe(false);
    expect(isDraftReady({ ...EMPTY_REPORT_DRAFT, needs: '   ' })).toBe(false);
    expect(isDraftReady({ ...EMPTY_REPORT_DRAFT, needs: 'Plateaux' })).toBe(true);
  });

  it('charge utile : rubriques vides omises, textes rognés', () => {
    expect(
      reportPayload('2026-11-02', {
        ...EMPTY_REPORT_DRAFT,
        successes: ' Deux commandes ',
        needs: '',
      }),
    ).toEqual({ weekStart: '2026-11-02', successes: 'Deux commandes' });
  });

  it('formulaire repris d’un bilan lu du serveur', () => {
    const report = {
      id: 'r',
      userId: USER,
      weekStart: '2026-11-02',
      successes: 'S',
      difficulties: null,
      needs: 'N',
      priorities: null,
      marketInfo: null,
      status: 'SUBMITTED',
      lastEditedAt: '2026-11-04T10:00:00.000Z',
      reviewedAt: null,
      reviewedBy: null,
      managerComment: null,
      version: 1,
    } as ServerWeeklyReport;
    expect(draftFromReport(report)).toEqual({
      ...EMPTY_REPORT_DRAFT,
      successes: 'S',
      needs: 'N',
    });
  });
});

describe('rédaction encore dans la file de l’appareil', () => {
  const command = (
    seq: number,
    payload: unknown,
    type = 'crm.weekly_report.submit',
    aggregate = 'agg',
    extra: Partial<OutboxCommand> = {},
  ) =>
    ({
      command_id: `c${seq}`,
      device_seq: seq,
      command_type: type,
      aggregate_id: aggregate,
      payload,
      status: 'PENDING_SYNC',
      occurred_at: '2026-11-04T10:00:00.000Z',
      ...extra,
    }) as unknown as OutboxCommand;

  it('une rédaction refusée par le serveur ne compte jamais : le texte figé reste celui du serveur', () => {
    const outbox = [
      command(1, { weekStart: '2026-11-02', successes: 'Refusé' }, undefined, 'agg', {
        status: 'REJECTED',
      }),
    ];
    expect(pendingReportDraft(outbox, 'agg')).toBeUndefined();
    expect(hasUnsentReport(outbox, 'agg')).toBe(false);
  });

  it('une rédaction déjà acceptée n’est retenue que si elle est plus récente que le bilan lu du serveur', () => {
    const accepted = (occurredAt: string) => [
      command(1, { weekStart: '2026-11-02', successes: 'Mon texte' }, undefined, 'agg', {
        status: 'SYNCED',
        occurred_at: occurredAt,
      }),
    ];
    const server = { lastEditedAt: '2026-11-04T12:00:00.000Z' };
    // Corrigé depuis un autre appareil à 12 h : le serveur fait foi.
    expect(pendingReportDraft(accepted('2026-11-04T10:00:00.000Z'), 'agg', server)).toBeUndefined();
    // Écrit ici à 13 h, le serveur ne l'a pas encore relu : la rédaction de l'appareil prime.
    expect(pendingReportDraft(accepted('2026-11-04T13:00:00.000Z'), 'agg', server)).toEqual({
      ...EMPTY_REPORT_DRAFT,
      successes: 'Mon texte',
    });
    // Sans lecture du serveur, la dernière rédaction de l'appareil est tout ce qu'on sait.
    expect(pendingReportDraft(accepted('2026-11-04T10:00:00.000Z'), 'agg')).toEqual({
      ...EMPTY_REPORT_DRAFT,
      successes: 'Mon texte',
    });
  });

  it('un brouillon non envoyé est local : il s’envoie même sans relire le serveur', () => {
    const waiting = [command(1, { weekStart: '2026-11-02', successes: 'En attente' })];
    expect(hasUnsentReport(waiting, 'agg')).toBe(true);
    const accepted = [
      command(1, { weekStart: '2026-11-02', successes: 'Accepté' }, undefined, 'agg', {
        status: 'SYNCED',
      }),
    ];
    expect(hasUnsentReport(accepted, 'agg')).toBe(false);
    expect(hasUnsentReport(waiting, 'inconnu')).toBe(false);
  });

  it('l’empreinte des textes change avec le contenu : un bilan corrigé n’est pas un duplicata', () => {
    const a = draftFingerprint({ ...EMPTY_REPORT_DRAFT, successes: 'Deux commandes' });
    expect(a).toBe(draftFingerprint({ ...EMPTY_REPORT_DRAFT, successes: ' Deux commandes ' }));
    expect(a).not.toBe(draftFingerprint({ ...EMPTY_REPORT_DRAFT, successes: 'Trois commandes' }));
    expect(a).not.toBe(draftFingerprint({ ...EMPTY_REPORT_DRAFT, needs: 'Deux commandes' }));
  });

  it('la plus récente prime ; une autre commande ou un autre bilan est ignoré', () => {
    const outbox = [
      command(1, { weekStart: '2026-11-02', successes: 'Ancien' }),
      command(3, { weekStart: '2026-11-02', successes: 'Récent', needs: 'Plateaux' }),
      command(2, { weekStart: '2026-11-02', successes: 'Milieu' }),
      command(
        4,
        { weekStart: '2026-11-02', successes: 'Autre bilan' },
        'crm.weekly_report.submit',
        'autre',
      ),
      command(5, { comment: 'Vu' }, 'crm.weekly_report.review'),
    ];
    expect(pendingReportDraft(outbox, 'agg')).toEqual({
      ...EMPTY_REPORT_DRAFT,
      successes: 'Récent',
      needs: 'Plateaux',
    });
    expect(pendingReportDraft(outbox, 'inconnu')).toBeUndefined();
  });
});
