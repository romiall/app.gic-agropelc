/**
 * ECR-DIS-02 « Ouverture et clôture de caisse » (UC-DIS-02 et 03, vendeur du PDV ; Finance). Hors ligne
 * : la caisse s'ouvre et se clôture sur l'appareil (commandes `finance.cash_session.open` et `.close`,
 * agrégat `CASH_SESSION`), le serveur calcule seul l'attendu et l'écart (BR-DIS-007) et les annonce
 * dans le résultat. Comptage à l'aveugle par défaut (AV-304) : l'attendu indicatif de l'appareil (D05
 * §12) ne s'affiche qu'après l'enregistrement du comptage. En ligne, une ouverture que le serveur
 * refuserait (session ouverte, chevauchement, limite du jour) est bloquée ; hors ligne, elle est
 * enregistrée et le serveur la rattache à la session retenue (AV-154).
 */
import { businessDayOf } from '@gic/domain';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { parseXaf } from '../sales/sale-form.js';
import { settingValue } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import {
  CASH_COUNT_BLIND,
  cashOpenPlan,
  deviceCash,
  foreignClose,
  indicativeBalanceXaf,
  indicativeSessionExpectedXaf,
  MAX_CASH_COMMENT,
  openSession,
  posCashAccounts,
} from './cash-session.js';
import { CashFigures, type IndicativeFigures } from './CashFigures.js';

interface Submitted {
  readonly commandId: string;
  readonly kind: 'open' | 'close';
  readonly indicative: IndicativeFigures | null;
}

export function CashSessionScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  const [countText, setCountText] = useState('');
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState<Submitted>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const ids = {
    account: useId(),
    count: useId(),
    countIssue: useId(),
    comment: useId(),
    blocked: useId(),
  };

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.cash_session')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const reset = () => {
    setCountText('');
    setComment('');
    setSubmitted(undefined);
    setSaveError(false);
  };

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.cash_session')}</h1>
        <CommandResult commandId={submitted.commandId} messages={`cash.${submitted.kind}.result`}>
          <button type="button" onClick={reset}>
            {t('cash.back')}
          </button>
        </CommandResult>
        <CashFigures
          commandId={submitted.commandId}
          kind={submitted.kind}
          indicative={submitted.indicative}
        />
      </section>
    );
  }

  const accounts = posCashAccounts(refs.cashAccounts);
  const account = accounts.find((candidate) => candidate.id === accountChoice) ?? accounts[0];
  if (!account) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.cash_session')}</h1>
        <p className="home-muted">{t('cash.no_account')}</p>
      </section>
    );
  }

  const now = clock.now();
  const maxSessionsPerDay = settingValue(
    refs.settings,
    'finance.cash_sessions_per_day_max',
    account.site_id,
    now,
  );
  const cash = deviceCash({
    cashAccountId: account.id,
    sessions: refs.cashSessions,
    outbox: refs.outbox,
    cashPulledAt: refs.cashPulledAt,
    userId,
    maxSessionsPerDay,
  });
  const sessions = cash.sessions;
  const current = openSession(cash);
  // Ouvertures d'autres utilisateurs de la tablette en attente de leur reconnexion : inconnues du
  // serveur, elles seront rattachées à la session ouverte entre-temps (AV-154, AV-167).
  const foreignNote =
    cash.foreignOpenings.length > 0 ? (
      <p className="home-muted">{t('cash.foreign_openings')}</p>
    ) : null;
  // Ouverture de l'utilisateur rattachée à une session existante : aucune caisse ouverte (AV-154).
  const attachedNote = cash.attached.at(-1) ? (
    <p className="text-warn" role="status">
      {t('cash.attached', { date: formatDateTime(cash.attached.at(-1)?.openedAt ?? '') })}
    </p>
  ) : null;
  const counted = parseXaf(countText);
  const countIssue = countText.trim() !== '' && counted === null;
  const trimmedComment = comment.trim();
  const movementsInput = {
    account,
    outbox: refs.outbox,
    cashPulledAt: refs.cashPulledAt,
    locations: refs.locations,
    paymentMethods: refs.paymentMethods,
  };

  const send = async (
    kind: 'open' | 'close',
    input: Parameters<typeof submitCommand>[0],
    expected: { readonly expectedXaf: number } | null,
  ) => {
    if (counted === null || busy) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setSubmitted({
        commandId: command.command_id,
        kind,
        indicative: expected ? { expectedXaf: expected.expectedXaf, countedXaf: counted } : null,
      });
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  const accountPicker =
    accounts.length > 1 ? (
      <div className="field">
        <label htmlFor={ids.account}>{t('cash.account_label')}</label>
        <select
          id={ids.account}
          className="text-input"
          value={account.id}
          onChange={(event) => {
            setAccountChoice(event.target.value);
            setCountText('');
            setComment('');
          }}
        >
          {accounts.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
    ) : (
      <p className="home-muted">{account.name}</p>
    );

  const countFields = (
    <>
      <div className="field">
        <label htmlFor={ids.count}>{t('cash.counted_label')}</label>
        <input
          id={ids.count}
          className="text-input"
          inputMode="numeric"
          autoComplete="off"
          value={countText}
          aria-invalid={countIssue}
          aria-describedby={countIssue ? ids.countIssue : undefined}
          onChange={(event) => setCountText(event.target.value)}
        />
        {countIssue ? (
          <p id={ids.countIssue} className="error-message">
            {t('cash.count_invalid')}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={ids.comment}>{t('cash.comment_label')}</label>
        <textarea
          id={ids.comment}
          className="text-input"
          rows={2}
          maxLength={MAX_CASH_COMMENT}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>
      {CASH_COUNT_BLIND ? <p className="home-muted">{t('cash.blind_hint')}</p> : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
    </>
  );

  if (current) {
    // La session ouverte n'est jamais l'ouverture d'un autre utilisateur pas encore envoyée
    // (`deviceCash`) : la clôture ne dépend que d'une ouverture de l'utilisateur.
    const expected = indicativeSessionExpectedXaf({ ...movementsInput, session: current });
    const previousDay = businessDayOf(new Date(current.openedAt)) < businessDayOf(now);
    const ready = counted !== null && !busy;
    const close = () =>
      void send(
        'close',
        {
          authorUserId: userId,
          commandType: 'finance.cash_session.close',
          aggregateType: 'CASH_SESSION',
          aggregateId: current.id,
          // Ouverture de l'utilisateur encore sur l'appareil : la clôture part après elle.
          ...(current.openCommandId ? { dependsOn: [current.openCommandId] } : {}),
          payload: {
            countedXaf: counted ?? 0,
            ...(trimmedComment ? { comment: trimmedComment } : {}),
          },
        },
        expected,
      );
    return (
      <section className="sale">
        <h1>{t('nav.screens.cash_session')}</h1>
        {accountPicker}
        {foreignNote}
        <section className="sale-block" aria-labelledby="cash-close-title">
          <h2 id="cash-close-title">{t('cash.close.title')}</h2>
          <p>
            {t('cash.open_state', {
              date: formatDateTime(current.openedAt),
              who: t(current.openedBy === userId ? 'cash.opened_by_you' : 'cash.opened_by_other'),
              amount: formatMoney(current.openingCountedXaf),
            })}
          </p>
          {current.openCommandId ? <p className="home-muted">{t('cash.open_pending')}</p> : null}
          {previousDay ? (
            <p className="text-warn" role="status">
              {t('cash.previous_day')}
            </p>
          ) : null}
          {!CASH_COUNT_BLIND && expected ? (
            <p className="home-muted">
              {t('cash.expected_indicative', { amount: formatMoney(expected.expectedXaf) })}
            </p>
          ) : null}
          <p className="home-muted">{t('cash.close.hint')}</p>
          {countFields}
          <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={close}>
            {busy ? t('sales.submitting') : t('cash.close.submit')}
          </button>
        </section>
      </section>
    );
  }

  // Pas de session ouverte : ouverture, contrôlée par la règle partagée avec le serveur.
  const plan = cashOpenPlan({ cash, userId, openedAt: now, online, maxSessionsPerDay });
  const refused = plan.kind === 'REJECT';
  const last = sessions.at(-1);
  const balance = indicativeBalanceXaf({ ...movementsInput, last });
  // Clôture d'un autre utilisateur pas encore envoyée : la session reste ouverte au serveur jusqu'à
  // sa reconnexion (ADR-052) ; une ouverture serait refusée en ligne, fusionnée hors ligne.
  const blockedByForeignClose = foreignClose(cash, userId) !== undefined;
  const ready = counted !== null && !busy && !refused && !blockedByForeignClose;
  const open = () =>
    void send(
      'open',
      {
        authorUserId: userId,
        commandType: 'finance.cash_session.open',
        aggregateType: 'CASH_SESSION',
        aggregateId: idGenerator.newId(),
        payload: {
          cashAccountId: account.id,
          countedXaf: counted ?? 0,
          ...(trimmedComment ? { comment: trimmedComment } : {}),
        },
      },
      balance,
    );
  return (
    <section className="sale">
      <h1>{t('nav.screens.cash_session')}</h1>
      {accountPicker}
      {last?.state === 'CLOSING' ? (
        <p className="home-muted">{t('cash.closing_pending')}</p>
      ) : last?.state === 'CLOSED' ? (
        <p className="home-muted">
          {t(
            last.closedStatus === 'PENDING_VALIDATION'
              ? 'cash.closed_to_validate'
              : last.closedStatus === 'VALIDATED'
                ? 'cash.closed_validated'
                : 'cash.closed_last',
          )}
        </p>
      ) : (
        <p className="home-muted">{t('cash.closed_state')}</p>
      )}
      {attachedNote}
      {foreignNote}
      <section className="sale-block" aria-labelledby="cash-open-title">
        <h2 id="cash-open-title">{t('cash.open.title')}</h2>
        {!CASH_COUNT_BLIND && balance ? (
          <p className="home-muted">
            {t('cash.expected_indicative', { amount: formatMoney(balance.expectedXaf) })}
          </p>
        ) : null}
        <p className="home-muted">{t('cash.open.hint')}</p>
        {countFields}
        {blockedByForeignClose ? (
          <p id={ids.blocked} className="home-muted">
            {t('sync.foreign_pending')}
          </p>
        ) : refused ? (
          <p id={ids.blocked} className="error-message" role="status">
            {t(`cash.open_refused.${plan.code}`)}
          </p>
        ) : plan.kind === 'MERGE' ? (
          <p className="text-warn" role="status">
            {t('cash.open_merge')}
          </p>
        ) : null}
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!ready}
          aria-describedby={refused || blockedByForeignClose ? ids.blocked : undefined}
          onClick={open}
        >
          {busy ? t('sales.submitting') : t('cash.open.submit')}
        </button>
      </section>
    </section>
  );
}
