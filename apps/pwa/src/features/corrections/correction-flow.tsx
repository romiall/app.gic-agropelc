/**
 * Corrections de la ferme (AV-526 ; règle 4 : rien ne disparaît, on corrige par annulation ou par une
 * opération de clôture) : une feuille de confirmation demande le motif — obligatoire pour une annulation,
 * il reste à l'historique de l'opération —, puis la commande part dans l'outbox comme toute écriture
 * (principe O1) ; le retour du serveur (acceptée, refusée avec sa raison en langage métier) s'affiche sous
 * l'écran. Les annulations de production partagent la même charge utile, `{ comment }`, avec l'identifiant
 * du document dans l'enveloppe (D07 : `*.cancel`, `lot.cancel_entry`, `weighing.cancel`…) ; la clôture d'un
 * lot n'a ni motif ni charge utile.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Field, Sheet, Textarea } from '../../components/ui/index.js';
import { CommandResult } from '../sales/CommandResult.js';
import { phaseOf, saveErrorKey, submitCommand, useOutboxCommand } from '../sales/submit.js';
import './corrections.css';

/** Longueur maximale du motif, celle du schéma de commande du serveur. */
export const MAX_CORRECTION_COMMENT = 2000;

/** Document à corriger et texte de la confirmation. */
export interface CorrectionTarget {
  readonly commandType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Titre de la feuille (« Annuler l'entrée de 500 têtes ? »), déjà traduit. */
  readonly title: string;
  /** Conséquences de l'opération, déjà traduites. */
  readonly hint: string;
  /** Libellé du bouton de confirmation, déjà traduit. */
  readonly confirmLabel: string;
  /** Préfixe i18n du retour de l'opération (`CommandResult`) ; défaut : `corrections.result`. */
  readonly messages?: string;
  /** Faux pour une opération sans motif (clôture d'un lot) : la charge utile est alors vide. */
  readonly commentRequired?: boolean;
}

export interface CorrectionFlow {
  /** Ouvre la feuille de confirmation pour ce document. */
  readonly ask: (target: CorrectionTarget) => void;
  /** Une opération sur ce document est partie et n'a pas été refusée : son bouton se retire. */
  readonly isPending: (aggregateId: string) => boolean;
  /** À rendre une fois dans l'écran : la feuille et le retour de la dernière opération. */
  readonly node: ReactNode;
}

interface Sent {
  readonly commandId: string;
  readonly aggregateId: string;
  readonly messages: string;
}

/**
 * Flux de correction d'un écran. `onDone` est appelé une fois par opération, quand le serveur l'a acceptée
 * (l'écran relit alors ses données en ligne).
 */
export function useCorrectionFlow(
  userId: string | undefined,
  options: { readonly onDone?: () => void } = {},
): CorrectionFlow {
  const { t } = useTranslation();
  const [target, setTarget] = useState<CorrectionTarget | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const command = useOutboxCommand(sent?.commandId);
  const phase = command ? phaseOf(command) : null;

  // L'écran relit ses données une seule fois par opération acceptée.
  const reported = useRef<string | null>(null);
  const onDone = options.onDone;
  useEffect(() => {
    if (!sent || (phase !== 'DONE' && phase !== 'WARNING')) return;
    if (reported.current === sent.commandId) return;
    reported.current = sent.commandId;
    onDone?.();
  }, [phase, sent, onDone]);

  const close = () => {
    setTarget(null);
    setComment('');
    setError(null);
  };

  const commentRequired = target?.commentRequired !== false;
  const confirm = async () => {
    if (!target || !userId || busy) return;
    if (commentRequired && comment.trim().length === 0) {
      setError(t('corrections.comment_required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const submitted = await submitCommand({
        authorUserId: userId,
        commandType: target.commandType,
        aggregateType: target.aggregateType,
        aggregateId: target.aggregateId,
        payload: commentRequired ? { comment: comment.trim() } : {},
      });
      setSent({
        commandId: submitted.command_id,
        aggregateId: target.aggregateId,
        messages: target.messages ?? 'corrections.result',
      });
      close();
    } catch (failure) {
      setError(t(saveErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };

  const node = (
    <>
      <Sheet
        open={target !== null}
        onClose={close}
        title={target?.title ?? ''}
        footer={
          <>
            <Button variant="tonal" onClick={close}>
              {t('corrections.keep')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void confirm()}>
              {target?.confirmLabel ?? ''}
            </Button>
          </>
        }
      >
        <p className="corrections-hint">{target?.hint}</p>
        {commentRequired ? (
          <Field label={t('corrections.comment_label')} hint={t('corrections.comment_hint')}>
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                maxLength={MAX_CORRECTION_COMMENT}
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
        ) : null}
        {error ? (
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        ) : null}
      </Sheet>
      {sent ? <CommandResult commandId={sent.commandId} messages={sent.messages} /> : null}
    </>
  );

  return {
    ask: (next) => {
      setComment('');
      setError(null);
      setTarget(next);
    },
    isPending: (aggregateId) =>
      sent?.aggregateId === aggregateId && phase !== 'REJECTED' && phase !== 'CONFLICT',
    node,
  };
}
