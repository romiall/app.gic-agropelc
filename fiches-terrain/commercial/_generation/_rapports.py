"""Feuilles de rapport (formules seules) : Rapport_Jour, Rapport_Semaine, Plan_Mensuel, Équipe."""

from __future__ import annotations

from openpyxl.chart import BarChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet.pagebreak import Break
from openpyxl.worksheet.datavalidation import DataValidation

from _donnees import (
    CMD_ANNULEE,
    ESPECES,
    M_CA,
    M_NVX_CLIENTS,
    M_PROSPECTS,
    M_VISITES,
    MV_AJUST_MOINS,
    MV_AJUST_PLUS,
    MV_CASSE,
    MV_ECHANTILLON,
    MV_PERTE,
    MV_RECU,
    MV_RETOUR,
    OP_VENTE_DIRECTE,
    ST_CLIENT,
    ST_PERDU,
    ST_PROSPECT,
    VISITE_SUR_PLACE,
    ETAPES,
)
from _outils import (
    BORDURE,
    COULEURS_ONGLETS,
    FMT_DATE,
    FMT_ENTIER,
    FMT_HEURE,
    FMT_POURCENT,
    FMT_XAF,
    GRIS_CALC,
    JAUNE,
    VERT_FONCE,
    ARDOISE,
    BLEU,
    cellule,
    cellule_saisie,
    definir_nom,
    entete_tableau,
    etiquette,
    fill,
    habiller_graphique,
    mise_en_page,
    police,
    proteger,
    regle_pourcentage,
    section,
)
from _kpi import (
    entre,
    iso_semaine,
    k_ca,
    k_casses,
    k_commandes_nb,
    k_commandes_xaf,
    k_contacts,
    k_encaisse,
    k_especes_a_verser,
    k_frais,
    k_jours_travailles,
    k_nouveaux_clients,
    k_objectif,
    k_prospects,
    k_visites,
    k_visites_commande,
    k_ventes_nb,
    nom_commercial,
)

JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
GRAND = "1000000000"


def validation_commercial() -> DataValidation:
    return DataValidation(
        type="list",
        formula1="=L_Equipe",
        allow_blank=False,
        showErrorMessage=True,
        errorStyle="warning",
        errorTitle="Commercial inconnu",
        error="Ce code ne figure pas dans la liste de l'équipe (feuille Paramètres). Vous pouvez le saisir quand même.",
    )


def validation_liste(nom: str, message: str) -> DataValidation:
    """Sélecteur d'un rapport : liste déroulante, une autre valeur reste permise après « OK »."""
    return DataValidation(
        type="list",
        formula1=f"={nom}",
        allow_blank=False,
        showErrorMessage=True,
        errorStyle="information",
        errorTitle="Valeur hors liste",
        error=message + " Cliquez sur OK pour la garder telle quelle.",
    )


def selecteur_date() -> DataValidation:
    return validation_liste("L_DatesPassees", "Choisissez la date dans la liste (aujourd'hui en tête).")


def selecteur_lundi() -> DataValidation:
    return validation_liste("L_LundisPasses", "Choisissez le lundi de la semaine dans la liste.")


def selecteur_mois() -> DataValidation:
    return validation_liste("L_Mois", "Choisissez le mois dans la liste.")


def _en_tete(ws, titre: str, sous_titre: str) -> None:
    ws["A1"] = titre
    ws["A1"].font = police(16, True, couleur=VERT_FONCE)
    ws["A2"] = sous_titre
    ws["A2"].font = police(10, False, True, ARDOISE)
    ws.row_dimensions[1].height = 26
    c = ws["A3"]
    c.value = "◄ Sommaire"
    c.hyperlink = "#'LISEZ-MOI'!A1"
    c.font = Font(name="Calibri", size=10, bold=True, color=BLEU, underline="single")


def _masquer(ws, colonne: str) -> None:
    ws.column_dimensions[colonne].hidden = True


# --- Rapport journalier --------------------------------------------------------------------------------------------------------


def rapport_jour(wb) -> None:
    ws = wb.create_sheet("Rapport_Jour")
    ws.sheet_properties.tabColor = COULEURS_ONGLETS["rapport"]
    for col, largeur in zip("ABCDEF", (36, 18, 18, 38, 18, 18)):
        ws.column_dimensions[col].width = largeur
    ws.column_dimensions["G"].width = 3
    ws.column_dimensions["J"].width = 8
    _en_tete(ws, "RAPPORT JOURNALIER", "Choisissez la date et le commercial (cellules jaunes) : tout le reste se calcule. Imprimez ou exportez en PDF pour l'envoyer à votre responsable.")

    etiquette(ws, 4, 1, "Date du rapport")
    cellule_saisie(ws, 4, 2, "=TODAY()", FMT_DATE, selecteur_date())
    etiquette(ws, 4, 4, "Commercial (code)")
    cellule_saisie(ws, 4, 5, "=Commercial_Id", None, validation_commercial())
    D, C = "$B$4", "$E$4"

    # ligne du Journal correspondant (0 = pas de ligne)
    ws["J4"] = f'=IFERROR(MATCH(1,INDEX((Jr_date={D})*(Jr_commercial={C}),0),0),0)'
    J = "$J$4"
    etiquette(ws, 5, 1, "Nom du commercial")
    cellule(ws, 5, 2, f"={nom_commercial(C)}", gras=True, couleur_fond=GRIS_CALC)
    ws.merge_cells("B5:C5")
    etiquette(ws, 5, 4, "Zone du jour")
    cellule(ws, 5, 5, f'=IF({J}=0,"",INDEX(Jr_zone,{J})&"")', couleur_fond=GRIS_CALC)
    ws.merge_cells("E5:F5")
    etiquette(ws, 6, 1, "Prise de service")
    cellule(ws, 6, 2, f'=IF({J}=0,"",IF(INDEX(Jr_debut,{J})="","",INDEX(Jr_debut,{J})))', FMT_HEURE, couleur_fond=GRIS_CALC, align="center")
    etiquette(ws, 6, 4, "Fin de service")
    cellule(ws, 6, 5, f'=IF({J}=0,"",IF(INDEX(Jr_fin,{J})="","",INDEX(Jr_fin,{J})))', FMT_HEURE, couleur_fond=GRIS_CALC, align="center")

    section(ws, 8, "INDICATEURS DU JOUR", 1, 6)
    gauche = [
        ("Visites sur place", k_visites(D, D, C), FMT_ENTIER),
        ("Contacts à distance (appels, messages)", k_contacts(D, D, C), FMT_ENTIER),
        ("Nouveaux prospects créés", k_prospects(D, D, C), FMT_ENTIER),
        ("Nouveaux clients (1ère vente)", k_nouveaux_clients(D, D, C), FMT_ENTIER),
        ("Frais engagés (XAF)", k_frais(D, D, C), FMT_XAF),
    ]
    droite = [
        ("Commandes prises (nombre)", k_commandes_nb(D, D, C), FMT_ENTIER),
        ("Commandes prises (XAF)", k_commandes_xaf(D, D, C), FMT_XAF),
        ("Chiffre d'affaires réalisé (XAF)", k_ca(D, D, C), FMT_XAF),
        ("Encaissé (XAF)", k_encaisse(D, D, C), FMT_XAF),
        ("Casses et pertes (valeur, XAF)", k_casses(D, D, C), FMT_XAF),
    ]
    for i, (lib, formule, fmt) in enumerate(gauche):
        cellule(ws, 9 + i, 1, lib, gras=True)
        cellule(ws, 9 + i, 2, f"={formule}", fmt, couleur_fond=GRIS_CALC, align="right", gras=True)
    for i, (lib, formule, fmt) in enumerate(droite):
        cellule(ws, 9 + i, 4, lib, gras=True)
        cellule(ws, 9 + i, 5, f"={formule}", fmt, couleur_fond=GRIS_CALC, align="right", gras=True)
    cellule(ws, 14, 1, "Espèces détenues, non encore versées (cumul)", gras=True)
    cellule(ws, 14, 2, f"={k_especes_a_verser(D, C)}", FMT_XAF, couleur_fond=GRIS_CALC, align="right", gras=True)
    cellule(ws, 14, 4, "Durée de la journée (heures)", gras=True)
    cellule(ws, 14, 5, f'=IF({J}=0,"",INDEX(Jr_amplitude,{J}))', "0.0", couleur_fond=GRIS_CALC, align="right", gras=True)

    # Visites et contacts du jour
    section(ws, 16, "VISITES ET CONTACTS DU JOUR (15 premières lignes)", 1, 6)
    entete_tableau(ws, 17, ["Client / prospect", "Type de contact", "Heure", "Objet → résultat", "Quartier", "Prochaine action"])
    for k in range(15):
        r = 18 + k
        ws[f"J{r}"] = (
            f'=IF({k + 1}>COUNTIFS(VC_date,{D},VC_commercial,{C}),"",'
            f'SMALL(INDEX(ROW(VC_date)+(((VC_date<>{D})+(VC_commercial<>{C}))>0)*{GRAND},0),{k + 1}))'
        )
        idx = f"$J{r}-5"
        cellule(ws, r, 1, f'=IF($J{r}="","",INDEX(VC_nomclient,{idx})&"")')
        cellule(ws, r, 2, f'=IF($J{r}="","",INDEX(VC_type,{idx})&"")')
        cellule(ws, r, 3, f'=IF($J{r}="","",IF(INDEX(VC_heure,{idx})="","",INDEX(VC_heure,{idx})))', FMT_HEURE, align="center")
        cellule(ws, r, 4, f'=IF($J{r}="","",INDEX(VC_objet,{idx})&IF(INDEX(VC_resultat,{idx})="",""," → "&INDEX(VC_resultat,{idx})))')
        cellule(ws, r, 5, f'=IF($J{r}="","",INDEX(VC_quartier,{idx})&"")')
        cellule(ws, r, 6, f'=IF($J{r}="","",IF(INDEX(VC_actiondate,{idx})="","",INDEX(VC_actiondate,{idx})))', FMT_DATE, align="center")

    # Commandes du jour
    section(ws, 34, "COMMANDES PRISES OU LIVRÉES CE JOUR (10 premières lignes)", 1, 6)
    entete_tableau(ws, 35, ["Client", "N° de commande / bon", "Quantité", "Produit", "Montant (XAF)", "Statut"])
    for k in range(10):
        r = 36 + k
        ws[f"J{r}"] = (
            f'=IF({k + 1}>SUMPRODUCT((((Cmd_date={D})+(Cmd_dateca={D}))>0)*(Cmd_commercial={C})),"",'
            f'SMALL(INDEX(ROW(Cmd_date)+(1-(((Cmd_date={D})+(Cmd_dateca={D}))>0)*(Cmd_commercial={C}))*{GRAND},0),{k + 1}))'
        )
        idx = f"$J{r}-5"
        cellule(ws, r, 1, f'=IF($J{r}="","",INDEX(Cmd_nomclient,{idx})&"")')
        cellule(ws, r, 2, f'=IF($J{r}="","",INDEX(Cmd_bon,{idx})&"")')
        cellule(ws, r, 3, f'=IF($J{r}="","",INDEX(Cmd_qte,{idx}))', "General", align="right")
        cellule(ws, r, 4, f'=IF($J{r}="","",INDEX(Cmd_produit,{idx})&IF(INDEX(Cmd_unite,{idx})="",""," ("&INDEX(Cmd_unite,{idx})&")"))')
        cellule(ws, r, 5, f'=IF($J{r}="","",INDEX(Cmd_montant,{idx}))', FMT_XAF, align="right")
        cellule(ws, r, 6, f'=IF($J{r}="","",INDEX(Cmd_type,{idx})&" · "&INDEX(Cmd_statut,{idx}))')

    # Encaissements du jour
    section(ws, 47, "ENCAISSEMENTS DU JOUR (8 premières lignes)", 1, 6)
    entete_tableau(ws, 48, ["Client", "Mode de paiement", "Montant (XAF)", "Référence de la transaction", "Versé à l'entreprise ?", "Reste dû du client (XAF)"])
    for k in range(8):
        r = 49 + k
        ws[f"J{r}"] = (
            f'=IF({k + 1}>COUNTIFS(Enc_date,{D},Enc_commercial,{C}),"",'
            f'SMALL(INDEX(ROW(Enc_date)+(((Enc_date<>{D})+(Enc_commercial<>{C}))>0)*{GRAND},0),{k + 1}))'
        )
        idx = f"$J{r}-5"
        cellule(ws, r, 1, f'=IF($J{r}="","",INDEX(Enc_nomclient,{idx})&"")')
        cellule(ws, r, 2, f'=IF($J{r}="","",INDEX(Enc_mode,{idx})&"")')
        cellule(ws, r, 3, f'=IF($J{r}="","",INDEX(Enc_montant,{idx}))', FMT_XAF, align="right")
        cellule(ws, r, 4, f'=IF($J{r}="","",INDEX(Enc_reference,{idx})&"")')
        cellule(ws, r, 5, f'=IF($J{r}="","",INDEX(Enc_verse,{idx})&"")', align="center")
        cellule(ws, r, 6, f'=IF($J{r}="","",INDEX(Enc_resteclient,{idx}))', FMT_XAF, align="right")

    # Stock confié
    section(ws, 58, "STOCK CONFIÉ AU COMMERCIAL (cumul jusqu'à la date du rapport)", 1, 6)
    entete_tableau(ws, 59, ["Produit", "Reçu (+ ajustements)", "Retourné au magasin", "Casses, pertes, échantillons", "Vendu (livré)", "Restant théorique"])
    for k in range(8):
        r = 60 + k
        p = f"$A{r}"
        cellule(ws, r, 1, f'=IFERROR(INDEX(L_Produit,{k + 1})&"","")')
        recu = (
            f'SUMIFS(Stk_qte,Stk_produit,{p},Stk_commercial,{C},Stk_mouvement,"{MV_RECU}",Stk_date,"<="&{D})'
            f'+SUMIFS(Stk_qte,Stk_produit,{p},Stk_commercial,{C},Stk_mouvement,"{MV_AJUST_PLUS}",Stk_date,"<="&{D})'
        )
        retour = f'SUMIFS(Stk_qte,Stk_produit,{p},Stk_commercial,{C},Stk_mouvement,"{MV_RETOUR}",Stk_date,"<="&{D})'
        pertes = "+".join(
            f'SUMIFS(Stk_qte,Stk_produit,{p},Stk_commercial,{C},Stk_mouvement,"{m}",Stk_date,"<="&{D})'
            for m in (MV_CASSE, MV_PERTE, MV_ECHANTILLON, MV_AJUST_MOINS)
        )
        vendu = f'SUMIFS(Cmd_qte,Cmd_produit,{p},Cmd_commercial,{C},Cmd_dateca,">0",Cmd_dateca,"<="&{D})'
        cellule(ws, r, 2, f'=IF({p}="","",{recu})', "General", align="right")
        cellule(ws, r, 3, f'=IF({p}="","",{retour})', "General", align="right")
        cellule(ws, r, 4, f'=IF({p}="","",{pertes})', "General", align="right")
        cellule(ws, r, 5, f'=IF({p}="","",{vendu})', "General", align="right")
        cellule(ws, r, 6, f'=IF({p}="","",B{r}-C{r}-D{r}-E{r})', "General", align="right", gras=True)

    # Bilan du jour
    section(ws, 69, "BILAN DU JOUR (saisi dans la feuille Journal)", 1, 6)
    for i, (lib, cle) in enumerate(
        [("Réussites du jour", "Jr_forts"), ("Difficultés rencontrées", "Jr_difficultes"), ("Besoin de soutien", "Jr_soutien"), ("Plan du lendemain", "Jr_demain")]
    ):
        r = 70 + i
        cellule(ws, r, 1, lib, gras=True, wrap=True)
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=6)
        cellule(ws, r, 2, f'=IF({J}=0,"",INDEX({cle},{J})&"")', wrap=True)
        for col in range(3, 7):
            ws.cell(r, col).border = BORDURE
        ws.row_dimensions[r].height = 44

    # Actions à mener
    section(ws, 75, "ACTIONS À MENER (les 6 plus proches, y compris en retard)", 1, 6)
    entete_tableau(ws, 76, ["Client / prospect", "Téléphone", "Date prévue", "À faire", "Statut", "Quartier"])
    for k in range(6):
        r = 77 + k
        ws[f"J{r}"] = (
            f'=IF(SMALL(INDEX(Cl_cleaction+(((Cl_cleaction=0)+(Cl_commercial<>{C}))>0)*{GRAND},0),{k + 1})>={GRAND},"",'
            f'ROUND(MOD(SMALL(INDEX(Cl_cleaction+(((Cl_cleaction=0)+(Cl_commercial<>{C}))>0)*{GRAND},0),{k + 1}),1)*100000,0))'
        )
        idx = f"$J{r}-5"
        cellule(ws, r, 1, f'=IF($J{r}="","",INDEX(Cl_nom,{idx})&"")')
        cellule(ws, r, 2, f'=IF($J{r}="","",INDEX(Cl_tel,{idx})&"")')
        cellule(ws, r, 3, f'=IF($J{r}="","",INDEX(Cl_actiondate,{idx}))', FMT_DATE, align="center")
        cellule(ws, r, 4, f'=IF($J{r}="","",INDEX(Cl_actiontexte,{idx})&"")')
        cellule(ws, r, 5, f'=IF($J{r}="","",INDEX(Cl_statut,{idx})&"")', align="center")
        cellule(ws, r, 6, f'=IF($J{r}="","",INDEX(Cl_quartier,{idx})&"")')

    # Visites prévues ce jour (Planning)
    section(ws, 84, "VISITES PRÉVUES CE JOUR (feuille Planning, 8 premières lignes)", 1, 6)
    entete_tableau(ws, 85, ["Client / prospect", "Quartier", "Téléphone", "Objectif de la visite", "Potentiel / jour", "Réalisé ?"])
    for k in range(8):
        r = 86 + k
        ws[f"J{r}"] = (
            f'=IF({k + 1}>COUNTIFS(Pl_jour,{D},Pl_commercial,{C}),"",'
            f'SMALL(INDEX(ROW(Pl_jour)+(((Pl_jour<>{D})+(Pl_commercial<>{C}))>0)*{GRAND},0),{k + 1}))'
        )
        idx = f"$J{r}-5"
        cellule(ws, r, 1, f'=IF($J{r}="","",INDEX(Pl_nomclient,{idx})&"")')
        cellule(ws, r, 2, f'=IF($J{r}="","",INDEX(Pl_quartier,{idx})&"")')
        cellule(ws, r, 3, f'=IF($J{r}="","",INDEX(Pl_tel,{idx})&"")')
        cellule(ws, r, 4, f'=IF($J{r}="","",INDEX(Pl_objet,{idx})&"")')
        cellule(ws, r, 5, f'=IF($J{r}="","",IF(N(INDEX(Pl_potentiel,{idx}))=0,"",INDEX(Pl_potentiel,{idx})))', "General", align="center")
        cellule(ws, r, 6, f'=IF($J{r}="","",INDEX(Pl_realise,{idx})&"")', align="center")

    for col in "J":
        _masquer(ws, col)
    mise_en_page(ws, "portrait", "A1:F93")
    ws.row_breaks.append(Break(id=68))
    proteger(ws)


# --- Rapport hebdomadaire ----------------------------------------------------------------------------------------------------------


def rapport_semaine(wb) -> None:
    ws = wb.create_sheet("Rapport_Semaine")
    ws.sheet_properties.tabColor = COULEURS_ONGLETS["rapport"]
    for col, largeur in zip("ABCDEFGHIJ", (30, 14, 13, 13, 13, 13, 17, 17, 17, 14)):
        ws.column_dimensions[col].width = largeur
    ws.column_dimensions["K"].width = 3
    ws.column_dimensions["Z"].width = 8
    _en_tete(ws, "RAPPORT HEBDOMADAIRE", "Choisissez le lundi de la semaine et le commercial (cellules jaunes). Les chiffres viennent de vos saisies ; les objectifs, de la feuille Objectifs.")

    etiquette(ws, 4, 1, "Lundi de la semaine")
    cellule_saisie(ws, 4, 2, "=TODAY()-WEEKDAY(TODAY(),2)+1", FMT_DATE, selecteur_lundi())
    etiquette(ws, 4, 4, "Commercial")
    cellule_saisie(ws, 4, 5, "=Commercial_Id", None, validation_commercial())
    ws.merge_cells("E4:F4")
    D, C = "$B$4", "$E$4"
    F = f"({D}+6)"  # dimanche
    etiquette(ws, 5, 1, "Semaine")
    cellule(ws, 5, 2, f"={iso_semaine(D)}", gras=True, couleur_fond=GRIS_CALC, align="center")
    etiquette(ws, 5, 4, "Nom")
    cellule(ws, 5, 5, f"={nom_commercial(C)}", gras=True, couleur_fond=GRIS_CALC)
    ws.merge_cells("E5:G5")
    ws["Z4"] = f'=IFERROR(MATCH(1,INDEX((Bil_lundi={D})*(Bil_commercial={C}),0),0),0)'
    B_ = "$Z$4"

    section(ws, 7, "1. ACTIVITÉ JOUR PAR JOUR", 1, 10)
    entete_tableau(ws, 8, ["Jour", "Date", "Visites sur place", "Contacts à distance", "Nouveaux prospects", "Nouveaux clients", "Commandes prises (XAF)", "CA réalisé (XAF)", "Encaissé (XAF)", "Frais (XAF)"], hauteur=34)
    for i in range(7):
        r = 9 + i
        cellule(ws, r, 1, JOURS[i], gras=True)
        cellule(ws, r, 2, f"={D}+{i}", FMT_DATE, couleur_fond=GRIS_CALC, align="center")
        d = f"$B{r}"
        specs = [
            (3, k_visites(d, d, C), FMT_ENTIER),
            (4, k_contacts(d, d, C), FMT_ENTIER),
            (5, k_prospects(d, d, C), FMT_ENTIER),
            (6, k_nouveaux_clients(d, d, C), FMT_ENTIER),
            (7, k_commandes_xaf(d, d, C), FMT_XAF),
            (8, k_ca(d, d, C), FMT_XAF),
            (9, k_encaisse(d, d, C), FMT_XAF),
            (10, k_frais(d, d, C), FMT_XAF),
        ]
        for col, formule, fmt in specs:
            cellule(ws, r, col, f"={formule}", fmt, couleur_fond=GRIS_CALC, align="right")
    cellule(ws, 16, 1, "TOTAL DE LA SEMAINE", gras=True, couleur_fond="D9E8DF")
    cellule(ws, 16, 2, None, couleur_fond="D9E8DF")
    for col in range(3, 11):
        lettre = chr(64 + col)
        cellule(ws, 16, col, f"=SUM({lettre}9:{lettre}15)", FMT_XAF if col >= 7 else FMT_ENTIER, gras=True, couleur_fond="D9E8DF", align="right")
    cellule(ws, 17, 1, "Objectif de la semaine", gras=True)
    cellule(ws, 18, 1, "Taux d'atteinte", gras=True)
    objectifs = {3: M_VISITES, 5: M_PROSPECTS, 6: M_NVX_CLIENTS, 8: M_CA}
    for col in range(2, 11):
        lettre = chr(64 + col)
        if col in objectifs:
            cellule(ws, 17, col, f"={k_objectif(objectifs[col], D, F, C, True)}", FMT_XAF if col == 8 else FMT_ENTIER, couleur_fond=GRIS_CALC, align="right")
            cellule(ws, 18, col, f'=IF(OR({lettre}17="",{lettre}17=0),"",{lettre}16/{lettre}17)', FMT_POURCENT, align="right")
        else:
            cellule(ws, 17, col, None, couleur_fond=GRIS_CALC)
            cellule(ws, 18, col, None)
    regle_pourcentage(ws, "C18:J18")
    cellule(ws, 19, 1, "Espèces détenues, non versées (cumul à fin de semaine)", gras=True, wrap=True)
    ws.row_dimensions[19].height = 30
    cellule(ws, 19, 3, f"={k_especes_a_verser(F, C)}", FMT_XAF, gras=True, couleur_fond=GRIS_CALC, align="right")

    section(ws, 21, "2. RÉSULTATS DES VISITES ET CONTACTS", 1, 4)
    entete_tableau(ws, 22, ["Résultat", "Nombre", "Part"], hauteur=22)
    n_res = 9
    for k in range(n_res):
        r = 23 + k
        cellule(ws, r, 1, f'=IFERROR(INDEX(L_Resultat,{k + 1})&"","")')
        cellule(ws, r, 2, f'=IF($A{r}="","",COUNTIFS(VC_resultat,$A{r},{entre("VC_date", D, F)},VC_commercial,{C}))', FMT_ENTIER, couleur_fond=GRIS_CALC, align="center")
        cellule(ws, r, 3, f'=IF(OR($A{r}="",$B$32=0),"",B{r}/$B$32)', FMT_POURCENT, couleur_fond=GRIS_CALC, align="center")
    cellule(ws, 32, 1, "Total des contacts (avec résultat)", gras=True)
    cellule(ws, 32, 2, f"=SUM(B23:B31)", FMT_ENTIER, gras=True, couleur_fond=GRIS_CALC, align="center")
    cellule(ws, 32, 3, None)
    cellule(ws, 33, 1, "Taux de conversion (commandes prises ÷ visites sur place)", gras=True, wrap=True)
    ws.row_dimensions[33].height = 30
    cellule(ws, 33, 2, f'=IF($C$16=0,"",COUNTIFS(VC_resultat,"Commande prise",{entre("VC_date", D, F)},VC_commercial,{C},VC_type,"{VISITE_SUR_PLACE}")/$C$16)', FMT_POURCENT, gras=True, couleur_fond=GRIS_CALC, align="center")
    cellule(ws, 33, 3, None)

    section(ws, 21, "3. MON PORTEFEUILLE (état actuel)", 6, 10)
    entete_tableau(ws, 22, ["Étape / statut", "", "Nombre"], col_debut=6, hauteur=22)
    ws.merge_cells("F22:G22")
    lignes = [(f"Prospects : {lib}", f'COUNTIFS(Cl_commercial,{C},Cl_statut,"{ST_PROSPECT}",Cl_etape,"{lib}")') for lib, _ in ETAPES]
    lignes += [
        ("Clients", f'COUNTIFS(Cl_commercial,{C},Cl_statut,"{ST_CLIENT}")'),
        ("Perdus", f'COUNTIFS(Cl_commercial,{C},Cl_statut,"{ST_PERDU}")'),
    ]
    for k, (lib, formule) in enumerate(lignes):
        r = 23 + k
        cellule(ws, r, 6, lib)
        ws.merge_cells(start_row=r, start_column=6, end_row=r, end_column=7)
        ws.cell(r, 7).border = BORDURE
        cellule(ws, r, 8, f"={formule}", FMT_ENTIER, couleur_fond=GRIS_CALC, align="center")
    r_tot = 23 + len(lignes)
    cellule(ws, r_tot, 6, "Total des comptes", gras=True)
    ws.merge_cells(start_row=r_tot, start_column=6, end_row=r_tot, end_column=7)
    ws.cell(r_tot, 7).border = BORDURE
    cellule(ws, r_tot, 8, f"=SUM(H23:H{r_tot - 1})", FMT_ENTIER, gras=True, couleur_fond=GRIS_CALC, align="center")
    cellule(ws, r_tot + 1, 6, "Comptes à surveiller (alerte)", gras=True)
    ws.merge_cells(start_row=r_tot + 1, start_column=6, end_row=r_tot + 1, end_column=7)
    ws.cell(r_tot + 1, 7).border = BORDURE
    cellule(ws, r_tot + 1, 8, f'=COUNTIFS(Cl_commercial,{C},Cl_alerte,"?*")', FMT_ENTIER, gras=True, couleur_fond=GRIS_CALC, align="center")

    section(ws, 35, "4. PLAN DE LA SEMAINE (feuille Planning)", 1, 4)
    cellule(ws, 36, 1, "Visites planifiées (jour prévu dans la semaine)", wrap=True)
    cellule(ws, 36, 2, f'=COUNTIFS({entre("Pl_jour", D, F)},Pl_commercial,{C})', FMT_ENTIER, couleur_fond=GRIS_CALC, align="center")
    cellule(ws, 37, 1, "dont réalisées", wrap=True)
    cellule(ws, 37, 2, f'=COUNTIFS({entre("Pl_jour", D, F)},Pl_commercial,{C},Pl_realise,"Visité")', FMT_ENTIER, couleur_fond=GRIS_CALC, align="center")
    cellule(ws, 38, 1, "Taux de réalisation du plan", gras=True)
    cellule(ws, 38, 2, '=IF(B36=0,"",B37/B36)', FMT_POURCENT, gras=True, couleur_fond=GRIS_CALC, align="center")
    regle_pourcentage(ws, "B38:B38")
    ws.row_dimensions[36].height = 30

    section(ws, 35, "5. MES 5 MEILLEURS CLIENTS (CA cumulé)", 6, 10)
    entete_tableau(ws, 36, ["Client", "", "", "CA cumulé (XAF)", "Reste dû (XAF)"], col_debut=6, hauteur=22)
    ws.merge_cells("F36:H36")
    for k in range(5):
        r = 37 + k
        cle = f"LARGE(INDEX(Cl_clecca*(Cl_commercial={C}),0),{k + 1})"
        ws[f"Z{r}"] = f'=IF({cle}=0,"",ROUND(MOD({cle},1)*1000000,0))'
        idx = f"$Z{r}-5"
        cellule(ws, r, 6, f'=IF($Z{r}="","",INDEX(Cl_nom,{idx})&"")')
        ws.merge_cells(start_row=r, start_column=6, end_row=r, end_column=8)
        for col in (7, 8):
            ws.cell(r, col).border = BORDURE
        cellule(ws, r, 9, f'=IF($Z{r}="","",INDEX(Cl_ca,{idx}))', FMT_XAF, couleur_fond=GRIS_CALC, align="right")
        cellule(ws, r, 10, f'=IF($Z{r}="","",INDEX(Cl_reste,{idx}))', FMT_XAF, couleur_fond=GRIS_CALC, align="right")

    section(ws, 43, "6. COMMENTAIRES DE LA SEMAINE (feuille Bilans_Hebdo)", 1, 10)
    for i, (lib, cle) in enumerate(
        [
            ("Réussites de la semaine", "Bil_reussites"),
            ("Difficultés rencontrées", "Bil_difficultes"),
            ("Besoins / demandes à la direction", "Bil_besoins"),
            ("Priorités de la semaine suivante", "Bil_priorites"),
            ("Infos marché", "Bil_marche"),
            ("Commentaire du responsable", "Bil_comresp"),
        ]
    ):
        r = 44 + i
        cellule(ws, r, 1, lib, gras=True, wrap=True)
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=10)
        cellule(ws, r, 2, f'=IF({B_}=0,"",INDEX({cle},{B_})&"")', wrap=True)
        for col in range(3, 11):
            ws.cell(r, col).border = BORDURE
        ws.row_dimensions[r].height = 40

    # Graphiques (à droite du tableau)
    graphique = BarChart()
    graphique.type = "col"
    graphique.title = "Visites et nouveaux prospects par jour"
    graphique.add_data(Reference(ws, min_col=3, min_row=8, max_row=15), titles_from_data=True)
    graphique.add_data(Reference(ws, min_col=5, min_row=8, max_row=15), titles_from_data=True)
    graphique.set_categories(Reference(ws, min_col=1, min_row=9, max_row=15))
    graphique.height, graphique.width = 7.5, 15
    graphique.legend.position = "b"
    habiller_graphique(graphique)
    ws.add_chart(graphique, "A52")
    graphique2 = BarChart()
    graphique2.type = "col"
    graphique2.title = "CA réalisé et encaissé par jour (XAF)"
    graphique2.add_data(Reference(ws, min_col=8, min_row=8, max_row=15), titles_from_data=True)
    graphique2.add_data(Reference(ws, min_col=9, min_row=8, max_row=15), titles_from_data=True)
    graphique2.set_categories(Reference(ws, min_col=1, min_row=9, max_row=15))
    graphique2.height, graphique2.width = 7.5, 15
    graphique2.legend.position = "b"
    habiller_graphique(graphique2)
    ws.add_chart(graphique2, "F52")

    section(ws, 51, "7. GRAPHIQUES", 1, 10)
    _masquer(ws, "Z")
    mise_en_page(ws, "landscape", "A1:J67")
    ws.row_breaks.append(Break(id=34))
    ws.row_breaks.append(Break(id=50))
    proteger(ws)


# --- Plan mensuel -----------------------------------------------------------------------------------------------------------------------


def plan_mensuel(wb) -> None:
    ws = wb.create_sheet("Plan_Mensuel")
    ws.sheet_properties.tabColor = COULEURS_ONGLETS["rapport"]
    for col, largeur in zip("ABCDEF", (34, 18, 20, 18, 18, 18)):
        ws.column_dimensions[col].width = largeur
    _en_tete(ws, "PLAN MENSUEL — semaine par semaine", "Reprend la logique de la fiche « État de déploiement » : PDV à couvrir et commande prévisionnelle par jour, pour chaque semaine du mois.")
    etiquette(ws, 4, 1, "Mois à analyser")
    cellule_saisie(ws, 4, 2, "=DATE(YEAR(TODAY()),MONTH(TODAY()),1)", "mmmm yyyy", selecteur_mois())
    etiquette(ws, 4, 4, "Commercial (code)")
    cellule_saisie(ws, 4, 5, "=Commercial_Id", None, validation_commercial())
    M, C = "$B$4", "$E$4"
    ws["H4"] = f"=DATE(YEAR({M}),MONTH({M}),1)"
    ws["I4"] = f"=DATE(YEAR({M}),MONTH({M})+1,0)"
    D1, D2 = "$H$4", "$I$4"
    etiquette(ws, 5, 1, "Nom")
    cellule(ws, 5, 2, f"={nom_commercial(C)}", gras=True, couleur_fond=GRIS_CALC)
    ws.merge_cells("B5:C5")

    section(ws, 7, "1. LES SEMAINES DU MOIS (feuille Planning)", 1, 6)
    entete_tableau(ws, 8, ["Semaine du mois", "PDV planifiés", "Commande prévisionnelle par jour (Σ)", "PDV visités", "PDV restant à visiter", "Taux de réalisation"], hauteur=46)
    for k in range(5):
        r = 9 + k
        cellule(ws, r, 1, f"Semaine {k + 1}", gras=True)
        base = f"Pl_commercial,{C},Pl_moisref,$H$4,Pl_semmois,{k + 1}"
        cellule(ws, r, 2, f"=COUNTIFS({base})", FMT_ENTIER, couleur_fond=GRIS_CALC, align="center")
        cellule(ws, r, 3, f"=SUMIFS(Pl_potentiel,{base})", "General", couleur_fond=GRIS_CALC, align="center")
        cellule(ws, r, 4, f'=COUNTIFS({base},Pl_realise,"Visité")', FMT_ENTIER, couleur_fond=GRIS_CALC, align="center")
        cellule(ws, r, 5, f"=B{r}-D{r}", FMT_ENTIER, couleur_fond=GRIS_CALC, align="center")
        cellule(ws, r, 6, f'=IF(B{r}=0,"",D{r}/B{r})', FMT_POURCENT, couleur_fond=GRIS_CALC, align="center")
    cellule(ws, 14, 1, "TOTAL COMMANDE PRÉVISIONNELLE PAR JOUR", gras=True, couleur_fond="D9E8DF", wrap=True)
    ws.row_dimensions[14].height = 30
    for col, lettre in ((2, "B"), (3, "C"), (4, "D"), (5, "E")):
        cellule(ws, 14, col, f"=SUM({lettre}9:{lettre}13)", FMT_ENTIER if col != 3 else "General", gras=True, couleur_fond="D9E8DF", align="center")
    cellule(ws, 14, 6, '=IF(B14=0,"",D14/B14)', FMT_POURCENT, gras=True, couleur_fond="D9E8DF", align="center")
    regle_pourcentage(ws, "F9:F14")

    section(ws, 16, "2. RÉSULTATS DU MOIS", 1, 6)
    entete_tableau(ws, 17, ["Indicateur", "Réalisé", "Objectif du mois", "Taux d'atteinte"], hauteur=24)
    lignes = [
        ("Visites sur place", k_visites(D1, D2, C), FMT_ENTIER, M_VISITES),
        ("Nouveaux prospects créés", k_prospects(D1, D2, C), FMT_ENTIER, M_PROSPECTS),
        ("Nouveaux clients (1ère vente)", k_nouveaux_clients(D1, D2, C), FMT_ENTIER, M_NVX_CLIENTS),
        ("Commandes prises (XAF)", k_commandes_xaf(D1, D2, C), FMT_XAF, None),
        ("Chiffre d'affaires réalisé (XAF)", k_ca(D1, D2, C), FMT_XAF, M_CA),
        ("Encaissé (XAF)", k_encaisse(D1, D2, C), FMT_XAF, None),
        ("Casses et pertes (XAF)", k_casses(D1, D2, C), FMT_XAF, None),
        ("Frais engagés (XAF)", k_frais(D1, D2, C), FMT_XAF, None),
    ]
    for k, (lib, formule, fmt, metrique) in enumerate(lignes):
        r = 18 + k
        cellule(ws, r, 1, lib, gras=True)
        cellule(ws, r, 2, f"={formule}", fmt, couleur_fond=GRIS_CALC, align="right")
        if metrique:
            cellule(ws, r, 3, f"={k_objectif(metrique, D1, D2, C, False)}", fmt, couleur_fond=GRIS_CALC, align="right")
            cellule(ws, r, 4, f'=IF(OR(C{r}="",C{r}=0),"",B{r}/C{r})', FMT_POURCENT, align="center")
        else:
            cellule(ws, r, 3, None, couleur_fond=GRIS_CALC)
            cellule(ws, r, 4, None)
    regle_pourcentage(ws, "D18:D25")
    cellule(ws, 27, 1, "Les objectifs du mois sont ceux des lignes de la feuille Objectifs dont la période dépasse 7 jours et couvre tout le mois.", taille=9, couleur_texte=ARDOISE, wrap=True)
    ws.merge_cells("A27:F27")
    ws.row_dimensions[27].height = 28
    ws.column_dimensions["H"].hidden = True
    ws.column_dimensions["I"].hidden = True
    mise_en_page(ws, "portrait", "A1:F27")
    proteger(ws)


# --- Équipe (responsable commercial) ---------------------------------------------------------------------------------------------------


def equipe(wb) -> None:
    ws = wb.create_sheet("Équipe")
    ws.sheet_properties.tabColor = COULEURS_ONGLETS["rapport"]
    largeurs = [10, 24, 22, 8, 8, 10, 10, 15, 15, 15, 16, 15, 9]
    for i, largeur in enumerate(largeurs, start=1):
        ws.column_dimensions[chr(64 + i)].width = largeur
    _en_tete(ws, "ÉQUIPE COMMERCIALE — vue du responsable", "Une ligne par commercial de la feuille Paramètres. Les chiffres viennent des lignes de chaque commercial (colonne « Commercial » des feuilles de saisie).")
    etiquette(ws, 4, 1, "Lundi de la semaine")
    ws.merge_cells("A4:B4")
    cellule_saisie(ws, 4, 3, "=TODAY()-WEEKDAY(TODAY(),2)+1", FMT_DATE, selecteur_lundi())
    D, F = "$C$4", "($C$4+6)"
    cellule(ws, 4, 5, "Semaine", gras=True, couleur_fond=GRIS_CALC, align="center")
    ws.merge_cells("E4:F4")
    cellule(ws, 4, 7, f"={iso_semaine(D)}", gras=True, couleur_fond=GRIS_CALC, align="center")
    ws.merge_cells("G4:H4")

    entetes = ["Code", "Nom", "Fonction", "Visites", "Contacts", "Nouveaux prospects", "Nouveaux clients", "Commandes prises (XAF)", "CA réalisé (XAF)", "Encaissé (XAF)", "Espèces non versées (cumul, XAF)", "Objectif CA semaine (XAF)", "% CA"]
    entete_tableau(ws, 6, entetes, hauteur=58)
    premiere, nb = 7, 15
    for k in range(nb):
        r = premiere + k
        code = f"$A{r}"
        cellule(ws, r, 1, f'=IF(INDEX(Equipe_Code,{k + 1})="","",INDEX(Equipe_Code,{k + 1}))', gras=True)
        cellule(ws, r, 2, f'=IF({code}="","",INDEX(Equipe_Nom,{k + 1})&"")')
        cellule(ws, r, 3, f'=IF({code}="","",INDEX(Equipe_Fonction,{k + 1})&"")')
        corps = [
            (4, k_visites(D, F, code), FMT_ENTIER),
            (5, k_contacts(D, F, code), FMT_ENTIER),
            (6, k_prospects(D, F, code), FMT_ENTIER),
            (7, k_nouveaux_clients(D, F, code), FMT_ENTIER),
            (8, k_commandes_xaf(D, F, code), FMT_XAF),
            (9, k_ca(D, F, code), FMT_XAF),
            (10, k_encaisse(D, F, code), FMT_XAF),
            (11, k_especes_a_verser(F, code), FMT_XAF),
        ]
        for col, formule, fmt in corps:
            cellule(ws, r, col, f'=IF({code}="","",{formule})', fmt, couleur_fond=GRIS_CALC, align="right")
        cellule(ws, r, 12, f'=IF({code}="","",{k_objectif(M_CA, D, F, code, True)})', FMT_XAF, couleur_fond=GRIS_CALC, align="right")
        cellule(ws, r, 13, f'=IF(OR({code}="",L{r}="",N(L{r})=0),"",I{r}/L{r})', FMT_POURCENT, align="center")
    derniere = premiere + nb - 1
    r = derniere + 1
    cellule(ws, r, 1, "TOTAL ÉQUIPE", gras=True, couleur_fond="D9E8DF")
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
    for col in (2, 3):
        ws.cell(r, col).border = BORDURE
    for col in list(range(4, 13)):
        lettre = chr(64 + col)
        fmt = FMT_XAF if col in (8, 9, 10, 11, 12) else FMT_ENTIER
        cellule(ws, r, col, f"=SUM({lettre}{premiere}:{lettre}{derniere})", fmt, gras=True, couleur_fond="D9E8DF", align="right")
    cellule(ws, r, 13, f'=IF(N(L{r})=0,"",I{r}/L{r})', FMT_POURCENT, gras=True, align="center")
    regle_pourcentage(ws, f"M{premiere}:M{r}")
    ws.freeze_panes = "D7"
    mise_en_page(ws, "landscape", f"A1:M{r}")
    proteger(ws)
