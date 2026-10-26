/**
 * Consulter et imprimer une opération dans la mise en page de sa pièce papier (lot PP, REQ-301,
 * REQ-302, ADR-048). La pièce est un document autonome posé dans une iframe : sa feuille de style
 * (la charte du papier) ne touche pas l'application, et l'impression ne prend que la pièce, au
 * format de page du gabarit. Tout est calculé sur l'appareil : utilisable hors ligne.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock } from '../../platform/composition.js';
import type { DemandePiece } from './demande.js';
import { documentPiece, LOGO_PIECES } from './document.js';
import { datePiece } from './format.js';
import { DIMENSIONS } from './gabarit.js';
import { rendrePiece } from './registre.js';
import { noterImpression, premiereImpression } from './reimpression.js';

const MM = 96 / 25.4;
/** Marges de l'aperçu à l'écran (`valeurs.css`, `@media screen`) : 4 mm autour et entre les feuilles. */
const MARGE = 4;

export interface PieceImprimableProps {
  readonly demande: DemandePiece;
  /** Identifiant stable de l'opération (marqueur de réimpression). */
  readonly cle: string;
  /** Opération annulée : tampon « ANNULÉE », case « pièce annulée » cochée. */
  readonly annulee?: boolean;
}

async function imprimerCadre(cadre: HTMLIFrameElement | null): Promise<void> {
  const w = cadre?.contentWindow;
  if (!w) return;
  try {
    await w.document.fonts?.ready;
  } catch {
    // Polices non chargées : on imprime quand même avec les polices de repli.
  }
  w.focus();
  w.print();
}

export function PieceImprimable({ demande, cle, annulee = false }: PieceImprimableProps) {
  const { t } = useTranslation();
  const cadre = useRef<HTMLIFrameElement>(null);
  const boite = useRef<HTMLDivElement>(null);
  const [largeur, setLargeur] = useState(0);
  // Date de la première impression sur cet appareil. Dès qu'elle est connue, l'aperçu porte déjà
  // la mention « DUPLICATA » : chaque impression suivante part directement du geste de l'utilisateur.
  const [deja, setDeja] = useState<string | null>(() => premiereImpression(cle));
  const [enAttente, setEnAttente] = useState(false);
  const duplicata = useMemo(() => (deja ? datePiece(clock.now().toISOString()) : null), [deja]);

  const rendu = useMemo(() => {
    try {
      const piece = rendrePiece(demande, { logo: LOGO_PIECES, marques: { annulee, duplicata } });
      return { piece, html: documentPiece(piece) };
    } catch {
      return null;
    }
  }, [demande, annulee, duplicata]);

  useEffect(() => {
    const el = boite.current;
    if (!el) return;
    const mesurer = () => setLargeur(el.clientWidth);
    mesurer();
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(mesurer);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  if (!rendu) {
    return (
      <p className="alert alert-error" role="alert">
        {t('piece.error')}
      </p>
    );
  }

  const [w, h] = DIMENSIONS[rendu.piece.fmt];
  const n = rendu.piece.pages.length;
  const cadreL = (w + 2 * MARGE) * MM;
  const cadreH = (n * (h + MARGE) + 2 * MARGE) * MM;
  const echelle = largeur > 0 ? Math.min(1, largeur / cadreL) : 1;

  const imprimer = () => {
    if (deja) {
      void imprimerCadre(cadre.current);
      return;
    }
    const ailleurs = premiereImpression(cle);
    if (ailleurs) {
      // Imprimée depuis l'ouverture (autre onglet, ou fin d'impression non signalée) : la pièce est
      // recalculée avec la mention, puis imprimée à son chargement.
      setDeja(ailleurs);
      setEnAttente(true);
      return;
    }
    // Le navigateur ne dit pas si l'impression a été annulée : la première impression est notée dès
    // l'ouverture de la boîte d'impression (AV-310).
    noterImpression(cle, clock.now());
    const w = cadre.current?.contentWindow;
    const apres = () => setDeja(premiereImpression(cle));
    if (w) w.addEventListener('afterprint', apres, { once: true });
    else apres();
    void imprimerCadre(cadre.current);
  };

  return (
    <div className="piece-imprimable">
      {deja ? (
        <p className="home-muted">{t('piece.duplicate_hint', { date: datePiece(deja) ?? '' })}</p>
      ) : null}
      <div className="result-actions no-print">
        <button type="button" onClick={imprimer}>
          {t('piece.print')}
        </button>
      </div>
      <div ref={boite} className="piece-apercu" style={{ height: cadreH * echelle }}>
        <iframe
          ref={cadre}
          title={t('piece.frame_title', { code: rendu.piece.code, title: rendu.piece.titre })}
          srcDoc={rendu.html}
          style={{
            width: cadreL,
            height: cadreH,
            transform: `scale(${echelle})`,
            transformOrigin: 'top left',
          }}
          onLoad={() => {
            if (!enAttente) return;
            setEnAttente(false);
            void imprimerCadre(cadre.current);
          }}
        />
      </div>
    </div>
  );
}
