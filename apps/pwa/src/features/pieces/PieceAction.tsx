/**
 * Action « Voir la pièce » d'une opération : ouvre la pièce papier remplie (consultation, REQ-302)
 * avec son bouton « Imprimer » (REQ-301). La demande n'est préparée qu'à l'ouverture.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/index.js';
import type { DemandePiece } from './demande.js';
import { PieceImprimable } from './PieceImprimable.js';

export interface PieceActionProps {
  /** Prépare la demande ; `null` : la pièce ne peut pas être produite (données absentes). */
  readonly demande: () => DemandePiece | null;
  readonly cle: string;
  readonly annulee?: boolean;
  /** Libellé du bouton, « Voir la pièce » par défaut. */
  readonly libelle?: string;
}

export function PieceAction({ demande, cle, annulee = false, libelle }: PieceActionProps) {
  const { t } = useTranslation();
  const [ouverte, setOuverte] = useState(false);
  const [preparee, setPreparee] = useState<DemandePiece | null>(null);

  const basculer = () => {
    if (ouverte) {
      setOuverte(false);
      return;
    }
    let prete: DemandePiece | null = null;
    try {
      prete = demande();
    } catch {
      // Données incohérentes : on affiche l'erreur plutôt que de casser l'écran.
    }
    setPreparee(prete);
    setOuverte(true);
  };

  return (
    <div className="piece-action no-print">
      {/* AV-488 (b), Q30 A : le bouton de la refonte (ADR-049), de sa largeur ; la pièce elle-même ne change pas. */}
      <Button variant="outline" aria-expanded={ouverte} onClick={basculer}>
        {ouverte ? t('piece.hide') : (libelle ?? t('piece.show'))}
      </Button>
      {ouverte ? (
        preparee ? (
          <PieceImprimable demande={preparee} cle={cle} annulee={annulee} />
        ) : (
          <p className="alert alert-error" role="alert">
            {t('piece.error')}
          </p>
        )
      ) : null}
    </div>
  );
}
