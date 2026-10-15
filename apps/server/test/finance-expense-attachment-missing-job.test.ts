/**
 * P9-07 : réglages de la tâche `finance.expenses.attachment_missing_check` (AV-407, AV-449) — 0 jour
 * désactive l'alerte (aucun sujet, mais une passe complète : les alertes ouvertes se ferment), une valeur
 * invalide revient aux défauts, l'horizon ne descend jamais sous le délai plus un jour, le seuil de
 * justificatif est lu à l'instant de la dépense. Test unitaire : les réglages, l'API d'`attachments` et la
 * publication sont simulés ; le balayage réel, la fenêtre SQL et la résolution par le marqueur sont
 * éprouvés par `finance-expense-decisions.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/index.js', () => ({
  currentSettingValue: vi.fn(),
}));
vi.mock('../src/modules/attachments/application/public/index.js', () => ({
  hasAvailableAttachment: vi.fn(),
}));
vi.mock('../src/modules/finance/application/expense-support.js', () => ({
  expenseSettingsAt: vi.fn(),
}));
vi.mock('../src/platform/events/detection-events.js', async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  publishDetectionEvent: vi.fn(),
  publishPassCompleted: vi.fn(),
}));

import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  EXPENSE_ATTACHMENT_MISSING_JOB_TYPE,
  ExpenseAttachmentMissingJob,
  attachmentScanWindow,
} from '../src/modules/finance/application/jobs/expense-attachment-missing-job.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { hasAvailableAttachment } from '../src/modules/attachments/application/public/index.js';
import { expenseSettingsAt } from '../src/modules/finance/application/expense-support.js';
import {
  publishDetectionEvent,
  publishPassCompleted,
} from '../src/platform/events/detection-events.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';

const NOW = new Date('2026-10-20T06:15:00.000Z');
const DAY_MS = 86_400_000;
const EXPENSE_ID = '0192a000-0000-7000-8000-0000000000e1';
const USER_ID = '0192a000-0000-7000-8000-0000000000a1';
const SITE_ID = '0192a000-0000-7000-8000-0000000000b1';

/**
 * Dépense reçue par le serveur il y a `daysAgo` jours (seuil de justificatif : 10 000 XAF), survenue il y
 * a `occurredDaysAgo` jours (hors ligne, la date du fait précède la réception).
 */
const expense = (daysAgo: number, amount = 20_000, occurredDaysAgo = daysAgo) => ({
  id: toBin(EXPENSE_ID),
  doc_number: 'DEP-TEST-1',
  site_id: toBin(SITE_ID),
  created_by: toBin(USER_ID),
  amount_xaf: amount,
  status: 'RECORDED',
  review_reasons: null,
  occurred_at: new Date(NOW.getTime() - occurredDaysAgo * DAY_MS),
  received_at_server: new Date(NOW.getTime() - daysAgo * DAY_MS),
  created_at: new Date(NOW.getTime() - daysAgo * DAY_MS),
});

let rows: unknown[] = [];
let scans = 0;
const uow = {
  selectFrom: () => {
    const chain = {
      select: () => chain,
      where: () => chain,
      orderBy: () => chain,
      execute: async () => {
        scans += 1;
        return rows;
      },
    };
    return chain;
  },
};

function settings(values: Record<string, unknown>) {
  vi.mocked(currentSettingValue).mockImplementation(
    async (_uow, input) => values[(input as { key: string }).key] as never,
  );
}

const run = () => {
  const registry = new JobHandlerRegistry();
  new ExpenseAttachmentMissingJob(
    { now: () => NOW } as never,
    { newId: () => '0192b000-0000-7000-8000-000000000001' } as never,
    registry,
  ).onModuleInit();
  return registry.resolve(EXPENSE_ATTACHMENT_MISSING_JOB_TYPE)!(uow as never, {});
};

describe('P9-07 : réglages de la détection des justificatifs de dépense manquants', () => {
  beforeEach(() => {
    vi.mocked(publishDetectionEvent).mockReset().mockResolvedValue(true);
    vi.mocked(publishPassCompleted).mockReset().mockResolvedValue(true);
    vi.mocked(hasAvailableAttachment).mockReset().mockResolvedValue(false);
    vi.mocked(expenseSettingsAt).mockReset().mockResolvedValue({
      approvalThresholdXaf: 50_000,
      photoThresholdXaf: 10_000,
      posCapXaf: 50_000,
    });
    rows = [expense(8)];
    scans = 0;
  });
  afterEach(() => vi.clearAllMocks());

  it('0 jour : alerte désactivée — aucun sujet, aucune lecture, mais le marqueur ferme les alertes ouvertes', async () => {
    settings({ 'attachments.missing_alert_days': 0 });
    await run();
    expect(publishDetectionEvent).not.toHaveBeenCalled();
    expect(scans).toBe(0);
    expect(hasAvailableAttachment).not.toHaveBeenCalled();
    expect(publishPassCompleted).toHaveBeenCalledTimes(1);
    expect(publishPassCompleted).toHaveBeenCalledWith(
      uow,
      expect.objectContaining({ alertType: 'ATTACHMENT_MISSING', scope: 'EXPENSE' }),
    );
  });

  it('fenêtre : l’horizon vaut au moins le délai plus un jour ; absent, nul ou invalide : 90 jours', () => {
    const window = (delay: number, horizon: unknown) => attachmentScanWindow(NOW, delay, horizon);
    expect(window(7, 30).horizonDays).toBe(30);
    expect(window(7, 7).horizonDays).toBe(8); // largeur nulle interdite
    expect(window(7, 3).horizonDays).toBe(8);
    for (const unset of [undefined, 0, -1, 'x', null, 2.5]) {
      expect(window(7, unset).horizonDays).toBe(90);
    }
    expect(window(100, undefined).horizonDays).toBe(101);
    const w = window(7, 30);
    expect(w.newest.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
    expect(w.oldest.getTime()).toBe(NOW.getTime() - 30 * DAY_MS);
  });

  it('réglage absent ou invalide : délai de 7 jours ; la passe publie son marqueur à portée EXPENSE', async () => {
    for (const bad of [undefined, 'sept', -3, 2.5, null]) {
      vi.mocked(publishDetectionEvent).mockClear();
      vi.mocked(publishPassCompleted).mockClear();
      settings({ 'attachments.missing_alert_days': bad });
      await run();
      expect(publishDetectionEvent).toHaveBeenCalledTimes(1);
      const [, , input] = vi.mocked(publishDetectionEvent).mock.calls[0]!;
      expect(input.payload).toMatchObject({ threshold_days: 7, days_missing: 8 });
      expect(input.passId).toMatch(/^ATTACHMENT_MISSING:EXPENSE:/);
      expect(publishPassCompleted).toHaveBeenCalledWith(
        uow,
        expect.objectContaining({ alertType: 'ATTACHMENT_MISSING', scope: 'EXPENSE' }),
      );
    }
  });

  it('seuil de justificatif lu à la date de la dépense : sous le seuil, rien ; pièce disponible, rien', async () => {
    settings({ 'attachments.missing_alert_days': 7 });
    rows = [expense(8, 10_000)]; // égal au seuil : strictement supérieur exigé
    await run();
    expect(publishDetectionEvent).not.toHaveBeenCalled();
    expect(publishPassCompleted).toHaveBeenCalledTimes(1); // la passe reste complète

    // Le seuil historisé se lit à l'instant du fait (20 jours), pas à celui de la réception (8 jours) ;
    // une lecture par instant distinct de dépense.
    vi.mocked(expenseSettingsAt).mockClear();
    rows = [expense(8, 20_000, 20), expense(8, 20_000, 20), expense(9, 20_000, 21)];
    await run();
    const readAt = vi.mocked(expenseSettingsAt).mock.calls.map(([, at]) => at.getTime());
    expect(readAt).toEqual([NOW.getTime() - 20 * DAY_MS, NOW.getTime() - 21 * DAY_MS]);
    vi.mocked(publishDetectionEvent).mockClear();

    vi.mocked(publishPassCompleted).mockClear();
    rows = [expense(8)];
    vi.mocked(hasAvailableAttachment).mockResolvedValue(true);
    await run();
    expect(publishDetectionEvent).not.toHaveBeenCalled();
    expect(publishPassCompleted).toHaveBeenCalledTimes(1);
    expect(hasAvailableAttachment).toHaveBeenCalledWith(uow, {
      ownerType: 'EXPENSE',
      ownerId: EXPENSE_ID,
    });
  });
});
