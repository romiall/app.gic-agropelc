"""Définition unique des indicateurs (formules Excel) partagés par les journaux et les rapports.

Chaque fonction renvoie une expression SANS « = » : `a` et `b` sont les bornes de dates (cellules), `c` la
cellule du code commercial. Les indicateurs sont toujours calculés à partir des lignes saisies, jamais saisis.
"""

from __future__ import annotations

from _donnees import (
    CMD_ANNULEE,
    ESPECES,
    MV_CASSE,
    MV_PERTE,
    OP_VENTE_DIRECTE,
    OUI,
    VISITE_SUR_PLACE,
)


def iso_semaine(cellule: str) -> str:
    """Semaine ISO « AAAA-Snn » sans fonction récente (compatible Excel 2010)."""
    jeudi = f"{cellule}-WEEKDAY({cellule},2)+4"
    premier = f"DATE(YEAR({jeudi}),1,3)"
    return f'YEAR({jeudi})&"-S"&TEXT(INT(({cellule}-{premier}+WEEKDAY({premier},2)+5)/7),"00")'


def entre(nom: str, a: str, b: str) -> str:
    return f'{nom},">="&{a},{nom},"<="&{b}'


def k_visites(a: str, b: str, c: str) -> str:
    return f'COUNTIFS({entre("VC_date", a, b)},VC_commercial,{c},VC_type,"{VISITE_SUR_PLACE}")'


def k_contacts(a: str, b: str, c: str) -> str:
    return f'COUNTIFS({entre("VC_date", a, b)},VC_commercial,{c},VC_type,"<>{VISITE_SUR_PLACE}",VC_type,"<>")'


def k_visites_commande(a: str, b: str, c: str) -> str:
    """Visites sur place dont le résultat est « Commande prise »."""
    return f'COUNTIFS({entre("VC_date", a, b)},VC_commercial,{c},VC_type,"{VISITE_SUR_PLACE}",VC_resultat,"Commande prise")'


def k_prospects(a: str, b: str, c: str) -> str:
    return f'COUNTIFS({entre("Cl_creation", a, b)},Cl_commercial,{c})'


def k_nouveaux_clients(a: str, b: str, c: str) -> str:
    return f'COUNTIFS({entre("Cl_vente1", a, b)},Cl_commercial,{c})'


def k_commandes_nb(a: str, b: str, c: str) -> str:
    return (
        f'SUMIFS(Cmd_premiere,{entre("Cmd_date", a, b)},Cmd_commercial,{c},'
        f'Cmd_statut,"<>{CMD_ANNULEE}",Cmd_type,"<>{OP_VENTE_DIRECTE}")'
    )


def k_commandes_xaf(a: str, b: str, c: str) -> str:
    return (
        f'SUMIFS(Cmd_montant,{entre("Cmd_date", a, b)},Cmd_commercial,{c},'
        f'Cmd_statut,"<>{CMD_ANNULEE}",Cmd_type,"<>{OP_VENTE_DIRECTE}")'
    )


def k_ca(a: str, b: str, c: str) -> str:
    return f'SUMIFS(Cmd_montant,{entre("Cmd_dateca", a, b)},Cmd_commercial,{c})'


def k_ventes_nb(a: str, b: str, c: str) -> str:
    """Nombre de ventes réalisées (un client servi un jour = une vente) : sert au panier moyen."""
    return f'SUMIFS(Cmd_venteunique,{entre("Cmd_dateca", a, b)},Cmd_commercial,{c})'


def k_encaisse(a: str, b: str, c: str) -> str:
    return f'SUMIFS(Enc_montant,{entre("Enc_date", a, b)},Enc_commercial,{c})'


def k_casses(a: str, b: str, c: str) -> str:
    return (
        f'SUMIFS(Stk_valeur,{entre("Stk_date", a, b)},Stk_commercial,{c},Stk_mouvement,"{MV_CASSE}")'
        f'+SUMIFS(Stk_valeur,{entre("Stk_date", a, b)},Stk_commercial,{c},Stk_mouvement,"{MV_PERTE}")'
    )


def k_frais(a: str, b: str, c: str) -> str:
    return f'SUMIFS(Jr_frais,{entre("Jr_date", a, b)},Jr_commercial,{c})'


def k_jours_travailles(a: str, b: str, c: str) -> str:
    return f'COUNTIFS({entre("Jr_date", a, b)},Jr_commercial,{c})'


def k_especes_a_verser(jusqua: str, c: str) -> str:
    """Espèces encaissées jusqu'à la date, moins ce qui a été versé à l'entreprise."""
    return (
        f'SUMIFS(Enc_montant,Enc_commercial,{c},Enc_mode,"{ESPECES}",Enc_date,"<="&{jusqua})'
        f'-SUMIFS(Enc_montant,Enc_commercial,{c},Enc_mode,"{ESPECES}",Enc_verse,"{OUI}",Enc_date,"<="&{jusqua})'
    )


def k_objectif(metrique: str, debut: str, fin: str, c: str, hebdo: bool) -> str:
    """Objectif dont la période couvre [debut, fin] ; « semaine » = période d'au plus 7 jours."""
    duree = '"<=7"' if hebdo else '">7"'
    base = f'Obj_commercial,{c},Obj_metrique,"{metrique}",Obj_debut,"<="&{debut},Obj_fin,">="&{fin},Obj_duree,{duree}'
    return f'IF(COUNTIFS({base})=0,"",SUMIFS(Obj_valeur,{base}))'


def nom_commercial(cell_code: str) -> str:
    return f'IFERROR(INDEX(Equipe_Nom,MATCH({cell_code},Equipe_Code,0))&"",IF({cell_code}=Commercial_Id,Commercial_Nom&"",""))'
