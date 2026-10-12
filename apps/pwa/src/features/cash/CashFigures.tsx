/**
 * Chiffres d'une ouverture ou d'une clôture de caisse, après l'enregistrement du comptage (ECR-DIS-02,
 * comptage à l'aveugle, AV-304) : ceux du serveur dès sa réponse (`server_refs`, chaînes décimales :
 * attendu, écart, statut de la session), sinon l'attendu indicatif calculé par l'appareil au moment de
 * la saisie (D05 §12), annoncé comme tel.
 */
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../sales/format.js';
import { phaseOf, useOutboxCommand } from '../sales/submit.js';

export interface IndicativeFigures {
  readonly expectedXaf: number;
  readonly countedXaf: number;
}

const numberOf = (value: string | undefined): number | null => {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function CashFigures({
  commandId,
  kind,
  indicative,
}: {
  readonly commandId: string;
  readonly kind: 'open' | 'close';
  readonly indicative: IndicativeFigures | null;
}) {
  const { t } = useTranslation();
  const command = useOutboxCommand(commandId);
  if (!command || phaseOf(command) === 'REJECTED') return null;
  const refs = command.server_refs ?? {};
  const expected = numberOf(kind === 'open' ? refs.openingExpectedXaf : refs.closingExpectedXaf);
  const variance = numberOf(kind === 'open' ? refs.openingVarianceXaf : refs.varianceXaf);
  if (expected !== null && variance !== null) {
    return (
      <section className="sale-block" aria-label={t('cash.figures_title')}>
        <p>{t('cash.expected_server', { amount: formatMoney(expected) })}</p>
        <p>{t('cash.variance_server', { amount: formatMoney(variance) })}</p>
        {kind === 'close' &&
        (refs.status === 'VALIDATED' || refs.status === 'PENDING_VALIDATION') ? (
          <p className="home-muted">{t(`cash.status_after_close.${refs.status}`)}</p>
        ) : null}
      </section>
    );
  }
  if (!indicative) return null;
  return (
    <section className="sale-block" aria-label={t('cash.figures_title')}>
      <p>{t('cash.expected_indicative', { amount: formatMoney(indicative.expectedXaf) })}</p>
      <p>
        {t('cash.variance_indicative', {
          amount: formatMoney(indicative.countedXaf - indicative.expectedXaf),
        })}
      </p>
      <p className="home-muted">{t('cash.indicative_hint')}</p>
    </section>
  );
}
