import { describe, expect, it } from 'vitest';
import {
  closeDiscrepancyPayload,
  currentVarianceXaf,
  imputationOptions,
  sessionReasonRequired,
  sessionValidationBlock,
  transferDecisionBlock,
  userLabel,
  validatePayload,
} from './treasury.js';

const ME = 'finance-1';

describe('Trésorerie (ECR-FIN-05)', () => {
  it('écart courant, motif exigé et valideur admis, comme le serveur', () => {
    const session = {
      status: 'PENDING_VALIDATION',
      openedBy: 'vendeur',
      closedBy: 'vendeur-2',
      forcedBy: null,
      openingVarianceXaf: 0,
      varianceXaf: -500,
    };
    const included = { treatment: 'INCLUDED_IN_VALIDATION', status: 'PENDING', deltaXaf: 300 };
    expect(currentVarianceXaf(session, [included])).toBe(-200);
    expect(currentVarianceXaf({ varianceXaf: null }, [])).toBe(0);
    // Motif : écart de clôture, d'ouverture, ou ajustement inclus en attente.
    expect(sessionReasonRequired(session, [])).toBe(true);
    expect(sessionReasonRequired({ ...session, varianceXaf: 0 }, [])).toBe(false);
    expect(sessionReasonRequired({ ...session, varianceXaf: 0, openingVarianceXaf: 100 }, [])).toBe(
      true,
    );
    expect(sessionReasonRequired({ ...session, varianceXaf: 0 }, [included])).toBe(true);
    expect(
      sessionReasonRequired({ ...session, varianceXaf: 0 }, [
        { ...included, status: 'VALIDATED' },
        { ...included, treatment: 'OWN_APPROVAL' },
      ]),
    ).toBe(false);
    // Valideur : ni l'ouvreur, ni le clôtureur, ni l'auteur de la clôture forcée.
    expect(sessionValidationBlock(session, ME)).toBeNull();
    expect(sessionValidationBlock(session, 'vendeur')).toBe('INVOLVED');
    expect(sessionValidationBlock(session, 'vendeur-2')).toBe('INVOLVED');
    expect(sessionValidationBlock({ ...session, forcedBy: ME }, ME)).toBe('INVOLVED');
    // Déjà validée (par un autre) : le statut d'abord, comme le serveur.
    expect(sessionValidationBlock({ ...session, status: 'VALIDATED' }, ME)).toBe('NOT_PENDING');
    expect(sessionValidationBlock({ ...session, status: 'VALIDATED' }, 'vendeur')).toBe(
      'NOT_PENDING',
    );
    expect(validatePayload('  Erreur de rendu ')).toEqual({ reason: 'Erreur de rendu' });
    expect(validatePayload('  ')).toEqual({});
  });

  it('écart de remise : décideur hors expéditeur, porteur et récepteur ; imputation ; charge utile', () => {
    const transfer = {
      status: 'DISCREPANCY_PENDING',
      sentBy: 'vendeur',
      receivedBy: 'finance-2',
      carrierUserId: 'porteur',
      carrierName: null,
      approvalRequestId: 'demande',
    };
    expect(transferDecisionBlock(transfer, ME)).toBeNull();
    expect(transferDecisionBlock(transfer, 'vendeur')).toBe('INVOLVED');
    expect(transferDecisionBlock(transfer, 'finance-2')).toBe('INVOLVED');
    expect(transferDecisionBlock(transfer, 'porteur')).toBe('INVOLVED');
    // Sans demande de validation liée : clos par la même commande (AV-183 harmonisé).
    const withoutRequest = { ...transfer, approvalRequestId: null };
    expect(transferDecisionBlock(withoutRequest, ME)).toBeNull();
    expect(transferDecisionBlock({ ...transfer, status: 'CLOSED' }, ME)).toBe('NOT_PENDING');
    expect(imputationOptions(transfer).map((choice) => [choice.option, choice.disabled])).toEqual([
      ['SENDER', false],
      ['CARRIER', false],
      ['RECEIVER', false],
      ['COMPANY', false],
    ]);
    // Porteur inconnu (ni utilisateur, ni nom) : l'écart ne peut pas lui être imputé.
    expect(
      imputationOptions({ carrierUserId: null, carrierName: null }).find(
        (choice) => choice.option === 'CARRIER',
      )?.disabled,
    ).toBe(true);
    expect(
      imputationOptions({ carrierUserId: null, carrierName: 'Paul' }).find(
        (choice) => choice.option === 'CARRIER',
      )?.disabled,
    ).toBe(false);
    expect(closeDiscrepancyPayload({ option: 'COMPANY', reason: ' Vol ' })).toEqual({
      imputation: 'COMPANY',
      reason: 'Vol',
    });
    expect(userLabel(ME, ME, 'vous')).toBe('vous');
    expect(userLabel('01900000-0000-7000-8000-0000000000e1', ME, 'vous')).toBe('…00e1');
    expect(userLabel(null, ME, 'vous')).toBe('');
  });
});
