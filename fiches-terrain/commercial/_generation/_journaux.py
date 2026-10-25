"""Définition des feuilles de saisie (journaux) de la fiche commerciale.

Chaque journal est décrit par une liste de colonnes (`Col`). Les formules des colonnes calculées utilisent des
noms définis (`Cl_nom`, `VC_date`…) créés par `construire_journal` : `{prefixe}_{clé de colonne}`.

Principe de saisie : un maximum de cellules se choisit dans une liste (dates, heures, clients, produits,
quantités, Oui/Non…) ; ce qui peut se déduire d'une autre saisie est calculé (statut du client, statut et numéro
de commande, prix, montant, versement, valeur des casses…).
"""

from __future__ import annotations

from _donnees import (
    A_RENSEIGNER,
    CMD_ANNULEE,
    CMD_ATTENTE,
    CMD_CONFIRMEE,
    CMD_LIVREE,
    ESPECES,
    M_QTE,
    MV_AJUST_PLUS,
    MV_CASSE,
    MV_ECHANTILLON,
    MV_PERTE,
    MV_RECU,
    NON,
    OP_VENTE_DIRECTE,
    OUI,
    P_MOIS,
    ST_CLIENT,
    ST_PERDU,
    ST_PROSPECT,
    TYPE_PARTICULIER,
    VISITE_SUR_PLACE,
)
from _kpi import (
    iso_semaine,
    k_casses,
    k_ca,
    k_commandes_nb,
    k_commandes_xaf,
    k_contacts,
    k_encaisse,
    k_nouveaux_clients,
    k_prospects,
    k_visites,
)
from _outils import (
    FMT_DATE,
    FMT_DATE_ZERO_CACHE,
    FMT_ENTIER,
    FMT_GPS,
    FMT_HEURE,
    FMT_TEXTE,
    FMT_XAF,
    Col,
    Journal,
)

NB_CLIENTS = 600
NB_PLANNING = 600
NB_VISITES = 2000
NB_COMMANDES = 2000
NB_ENCAISSEMENTS = 1500
NB_STOCK = 1500
NB_JOURNAL = 200
NB_OBJECTIFS = 200
NB_BILANS = 80


# --- Formules communes -----------------------------------------------------------------------------------------


def prefixe_code(commercial: str) -> str:
    return f'IF({commercial}="{A_RENSEIGNER}","GIC",{commercial})'


def code_client(num: str, commercial: str, r: int) -> str:
    """Code lisible du client : « COM01-012 » (préfixe = code du commercial)."""
    return f'=IF({num}{r}="","",{prefixe_code(f"{commercial}{r}")}&"-"&TEXT({num}{r},"000"))'


def cols_client(etiquette: str, commercial: str) -> list:
    """Colonnes calculées à partir d'une cellule « client » (libellé « Resto La Paix [012] »)."""
    return [
        Col(
            "numclient",
            "N° client",
            9,
            "calc",
            FMT_ENTIER,
            "Calculé",
            f=lambda r, L: (
                f'=IF({L[etiquette]}{r}="","",IFERROR(VALUE(MID({L[etiquette]}{r},LEN({L[etiquette]}{r})-3,3)),""))'
            ),
            align="center",
        ),
        Col(
            "cle",
            "Clé client",
            14,
            "calc",
            None,
            "Technique",
            f=lambda r, L: f'=IF({L["numclient"]}{r}="","",{L[commercial]}{r}&"|"&{L["numclient"]}{r})',
            cache=True,
        ),
        Col(
            "code",
            "Code client",
            12,
            "calc",
            None,
            "Calculé",
            f=lambda r, L: code_client(L["numclient"], L[commercial], r),
            tgt="crm.customers (identifiant de rapprochement)",
        ),
        Col(
            "nomclient",
            "Nom du client",
            30,
            "calc",
            None,
            "Calculé",
            f=lambda r, L: (
                f'=IF({L["cle"]}{r}="","",IFERROR(INDEX(Cl_nom,MATCH({L["cle"]}{r},Cl_cle,0)),"(client introuvable)"))'
            ),
        ),
    ]


def col_quartier_client() -> Col:
    return Col(
        "quartier",
        "Quartier",
        18,
        "calc",
        None,
        "Calculé",
        f=lambda r, L: f'=IF({L["cle"]}{r}="","",IFERROR(INDEX(Cl_quartier,MATCH({L["cle"]}{r},Cl_cle,0))&"",""))',
    )


def col_commercial(cle: str) -> Col:
    return Col(
        "commercial",
        "Commercial",
        13,
        "calc",
        None,
        "Rempli seul (Paramètres) ; remplaçable",
        f=lambda r, L: f'=IF({L[cle]}{r}="","",Commercial_Id)',
        tgt="identity.users (auteur / titulaire)",
    )


def col_ref(cle: str, lettre: str, num_key: str = "num") -> Col:
    def formule(r: int, L: dict) -> str:
        com = f"{L['commercial']}{r}"
        return f'=IF({L[cle]}{r}="","",{prefixe_code(com)}&"-{lettre}"&TEXT({L[num_key]}{r},"00000"))'

    return Col(
        "ref",
        "Réf. de la ligne",
        14,
        "calc",
        None,
        "Calculé",
        f=formule,
        tgt="(clé d'import : évite les doublons)",
    )


def col_semaine(date_key: str) -> Col:
    return Col(
        "semaine",
        "Semaine",
        10,
        "calc",
        None,
        "Calculé (ISO)",
        f=lambda r, L: f'=IF({L[date_key]}{r}="","",{iso_semaine(f"{L[date_key]}{r}")})',
        align="center",
    )


def col_num() -> Col:
    return Col("num", "N°", 6, "static", FMT_ENTIER, "", nommer=True)


def prix_reference(produit: str, r: int, L: dict) -> str:
    """Prix de référence du produit (feuille Listes) ; vide tant que la direction ne l'a pas renseigné."""
    return f'=IF({L[produit]}{r}="","",IFERROR(1/(1/VLOOKUP({L[produit]}{r},T_Produits,3,FALSE)),""))'


def col_unite(produit: str = "produit") -> Col:
    return Col(
        "unite",
        "Unité",
        10,
        "calc",
        None,
        "Selon le produit",
        f=lambda r, L: f'=IF({L[produit]}{r}="","",IFERROR(VLOOKUP({L[produit]}{r},T_Produits,2,FALSE),""))',
        align="center",
    )


# --- Clients -----------------------------------------------------------------------------------------------------


def journal_clients() -> Journal:
    def code(r, L):
        com = f"{L['commercial']}{r}"
        return f'=IF({L["nom"]}{r}="","",{prefixe_code(com)}&"-"&TEXT({L["num"]}{r},"000"))'

    def ligne_dernier_contact(r, L):
        return f'ROUND(MOD({L["clecontact"]}{r},1)*100000,0)-5'

    cols = [
        col_num(),
        Col("code", "Code client", 12, "calc", None, "Calculé", f=code, tgt="crm.customers (identifiant de rapprochement)"),
        Col("nom", "Enseigne / nom du client", 32, "in", None, "Nom de l'établissement ou de la personne", req=True, tgt="crm.customers.display_name"),
        Col(
            "statut", "Statut (automatique)", 12, "calc", None, "Prospect → Client à la 1ère vente",
            f=lambda r, L: (
                f'=IF({L["nom"]}{r}="","",IF({L["perdu"]}{r}="{OUI}","{ST_PERDU}",IF({L["vente1"]}{r}<>"","{ST_CLIENT}","{ST_PROSPECT}")))'
            ),
            align="center", tgt="crm.customers.stage",
        ),
        Col("type", "Type de client", 26, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_TypeClient"}, tgt="crm.customers.category_id (catalog.customer_categories)"),
        Col("interlocuteur", "Interlocuteur (personne à contacter)", 24, "in", None, "Nom du contact", tgt="crm.customers.contact_name"),
        Col("tel", "Téléphone principal", 16, "in", FMT_TEXTE, "9 chiffres ou +237…", dv=lambda L: {"type": "perso", "formule": f'OR(LEN(SUBSTITUTE({L["tel"]}6," ",""))>=9,{L["tel"]}6="")', "message": "Un numéro camerounais compte au moins 9 chiffres (ex. 677122395)."}, tgt="crm.customers.phone_primary"),
        Col("tel2", "Téléphone 2 / WhatsApp", 16, "in", FMT_TEXTE, "Facultatif", tgt="crm.customers.phone_secondary"),
        Col("quartier", "Quartier / zone", 20, "in", None, "Liste (ou autre quartier)", dv={"type": "liste", "nom": "L_Zone", "souple": True}, tgt="crm.customers.zone_id (organization.zones)"),
        Col("repere", "Localisation précise / point de repère", 34, "in", None, "Ex. face station, entrée marché…", tgt="crm.customers.address_text"),
        Col("lat", "Latitude", 11, "in", FMT_GPS, "Facultatif (Google Maps)", tgt="crm.customers.lat"),
        Col("lng", "Longitude", 11, "in", FMT_GPS, "Facultatif (Google Maps)", tgt="crm.customers.lng"),
        Col("source", "Source du prospect", 24, "in", None, "Liste", dv={"type": "liste", "nom": "L_Source"}, tgt="crm.customers.source_code (crm.lead_sources)"),
        Col("etape", "Étape du pipeline", 15, "in", None, "Liste (prospects)", req_si=lambda L: f'AND({L["statut"]}6="{ST_PROSPECT}",{L["etape"]}6="")', dv={"type": "liste", "nom": "L_Etape"}, tgt="crm.customers.pipeline_step_id (crm.pipeline_steps)"),
        Col("creation", "Date de création", 16, "in", FMT_DATE, "Liste de dates", req=True, dv={"type": "date_passee"}, align="center", date=True, tgt="crm.customers.acquired_at"),
        Col("produit", "Produit principal d'intérêt", 28, "in", None, "Liste", dv={"type": "liste", "nom": "L_Produit"}, tgt="(information commerciale, hors modèle client)"),
        Col("potentiel", "Potentiel estimé par jour (quantité)", 14, "in", "General", "Commande prévisionnelle / jour", dv={"type": "quantite"}, tgt="(information commerciale, hors modèle client)"),
        col_unite(),
        Col("paiement", "Mode de paiement habituel", 18, "in", None, "Liste", dv={"type": "liste", "nom": "L_Paiement"}, tgt="(information commerciale)"),
        Col("differe", "Paiement différé demandé ?", 13, "in", None, "Liste", dv={"type": "liste", "nom": "L_OuiNon"}, align="center", tgt="crm.customers.credit_allowed (décision du responsable)"),
        Col("perdu", "Compte perdu ?", 12, "in", None, "Liste", dv={"type": "liste", "nom": "L_OuiNon"}, align="center", tgt="crm.customers.stage = LOST"),
        Col("motifperte", "Motif de perte", 24, "in", None, "Si perdu", req_si=lambda L: f'AND({L["perdu"]}6="{OUI}",{L["motifperte"]}6="")', dv={"type": "liste", "nom": "L_MotifPerte"}, tgt="crm.customers.lost_reason_code_id (PROSPECT_LOST)"),
        Col("obs", "Observations", 36, "in", None, "Libre", tgt="crm.customers (note)"),
        col_commercial("nom"),
        # --- calculs ---
        Col("nature", "Particulier / entreprise", 14, "calc", None, "Calculé", f=lambda r, L: f'=IF({L["type"]}{r}="","",IF({L["type"]}{r}="{TYPE_PARTICULIER}","Particulier","Entreprise"))', tgt="crm.customers.customer_type"),
        Col("nbvisites", "Nb de visites", 9, "calc", FMT_ENTIER, "Calculé", f=lambda r, L: f'=IF({L["nom"]}{r}="","",COUNTIFS(VC_cle,{L["cle"]}{r},VC_type,"{VISITE_SUR_PLACE}"))', align="center"),
        Col("dernier", "Dernier contact", 12, "calc", FMT_DATE, "Calculé", f=lambda r, L: f'=IF({L["clecontact"]}{r}=0,"",IF(INT({L["clecontact"]}{r})=0,"",INT({L["clecontact"]}{r})))', align="center"),
        Col("actiondate", "Prochaine action (date)", 13, "calc", FMT_DATE, "Vient du dernier contact", f=lambda r, L: (
            f'=IF({L["clecontact"]}{r}=0,"",IF(INDEX(VC_actiondate,{ligne_dernier_contact(r, L)})=0,"",INDEX(VC_actiondate,{ligne_dernier_contact(r, L)})))'
        ), align="center"),
        Col("actiontexte", "Prochaine action (à faire)", 28, "calc", None, "Vient du dernier contact", f=lambda r, L: (
            f'=IF({L["clecontact"]}{r}=0,"",INDEX(VC_actiontexte,{ligne_dernier_contact(r, L)})&"")'
        )),
        Col("vente1", "Date de la 1ère vente", 13, "calc", FMT_DATE, "Calculé : devient client", f=lambda r, L: (
            f'=IF({L["nom"]}{r}="","",IF(COUNTIFS(Cmd_cle,{L["cle"]}{r},Cmd_dateca,">0")=0,"",'
            f'SMALL(INDEX(Cmd_dateca+(((Cmd_cle<>{L["cle"]}{r})+(Cmd_dateca=0))>0)*1000000,0),1)))'
        ), align="center", tgt="crm.customers.converted_at"),
        Col("dernierevente", "Dernier achat", 12, "calc", FMT_DATE, "Calculé", f=lambda r, L: (
            f'=IF({L["nom"]}{r}="","",IF(COUNTIFS(Cmd_cle,{L["cle"]}{r},Cmd_dateca,">0")=0,"",'
            f'MAX(INDEX((Cmd_cle={L["cle"]}{r})*Cmd_dateca,0))))'
        ), align="center"),
        Col("ca", "CA cumulé (XAF)", 14, "calc", FMT_XAF, "Calculé", f=lambda r, L: f'=IF({L["nom"]}{r}="","",SUMIFS(Cmd_montant,Cmd_cle,{L["cle"]}{r},Cmd_dateca,">0"))'),
        Col("encaisse", "Encaissé (XAF)", 14, "calc", FMT_XAF, "Calculé", f=lambda r, L: f'=IF({L["nom"]}{r}="","",SUMIFS(Enc_montant,Enc_cle,{L["cle"]}{r}))'),
        Col("reste", "Reste à encaisser (XAF)", 14, "calc", FMT_XAF, "CA − encaissé", f=lambda r, L: f'=IF({L["nom"]}{r}="","",{L["ca"]}{r}-{L["encaisse"]}{r})'),
        Col("alerte", "Alerte", 20, "calc", None, "Ce qui demande votre attention", f=lambda r, L: (
            f'=IF({L["nom"]}{r}="","",IF({L["statut"]}{r}="{ST_PERDU}","",'
            f'IF(AND({L["actiondate"]}{r}<>"",N({L["actiondate"]}{r})<TODAY()),"Action en retard",'
            f'IF(AND({L["statut"]}{r}="{ST_CLIENT}",{L["dernierevente"]}{r}<>"",TODAY()-N({L["dernierevente"]}{r})>P_JoursInactif),"Client inactif",'
            f'IF(AND({L["statut"]}{r}="{ST_PROSPECT}",{L["nbvisites"]}{r}=0,{L["creation"]}{r}<>"",TODAY()-N({L["creation"]}{r})>P_JoursNonVisite),"Jamais visité","")))))'
        )),
        Col("label", "Libellé (liste déroulante)", 30, "calc", None, "Technique", f=lambda r, L: f'=IF({L["nom"]}{r}="","",{L["nom"]}{r}&" ["&TEXT({L["num"]}{r},"000")&"]")', cache=True),
        Col("cle", "Clé client", 14, "calc", None, "Technique", f=lambda r, L: f'=IF({L["nom"]}{r}="","",{L["commercial"]}{r}&"|"&{L["num"]}{r})', cache=True),
        Col("clecontact", "Clé dernier contact", 14, "calc", "0.00000", "Technique", f=lambda r, L: (
            f'=IF({L["nom"]}{r}="",0,IF(COUNTIFS(VC_cle,{L["cle"]}{r})=0,0,'
            f'MAX(INDEX((VC_cle={L["cle"]}{r})*(VC_date+ROW(VC_date)/100000),0))))'
        ), cache=True),
        Col("cleaction", "Clé prochaine action", 14, "calc", "0.00000", "Technique", f=lambda r, L: (
            f'=IF(AND({L["nom"]}{r}<>"",N({L["actiondate"]}{r})>0,{L["statut"]}{r}<>"{ST_PERDU}"),{L["actiondate"]}{r}+ROW()/100000,0)'
        ), cache=True),
        Col("clecca", "Clé classement CA", 14, "calc", "0.000000", "Technique", f=lambda r, L: f'=IF(N({L["ca"]}{r})>0,ROUND({L["ca"]}{r},0)+ROW()/1000000,0)', cache=True),
    ]
    return Journal(
        nom="Clients",
        titre="CLIENTS ET PROSPECTS — mon portefeuille",
        sous_titre="Une ligne par client ou prospect. Le statut devient « Client » tout seul à la première vente. Les colonnes grises se calculent seules.",
        prefixe="Cl",
        cols=cols,
        lignes=NB_CLIENTS,
        onglet="portefeuille",
        gel="D6",
        entite_cible="crm.customers",
    )


# --- Planning ------------------------------------------------------------------------------------------------------


def journal_planning() -> Journal:
    cols = [
        col_num(),
        Col("mois", "Mois", 16, "in", "mmmm yyyy", "Liste des mois", req=True, dv={"type": "mois"}, align="center", date=True),
        Col("semmois", "Semaine du mois (1 à 5)", 12, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_SemMois"}, align="center"),
        Col("jour", "Jour prévu (si connu)", 16, "in", FMT_DATE, "Liste de dates", dv={"type": "date_avenir"}, align="center", date=True),
        Col("client", "Client / PDV à visiter", 38, "in", None, "Liste des clients", req=True, dv={"type": "liste", "nom": "L_Clients"}),
        Col("objet", "Objectif de la visite", 28, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_ObjetVisite"}),
        Col("remarque", "Remarques", 34, "in", None, "Libre"),
        col_commercial("client"),
        *cols_client("client", "commercial"),
        Col("moisref", "Mois (1er jour)", 12, "calc", FMT_DATE, "Technique", f=lambda r, L: f'=IF({L["mois"]}{r}="","",DATE(YEAR({L["mois"]}{r}),MONTH({L["mois"]}{r}),1))', align="center", cache=True),
        col_quartier_client(),
        Col("tel", "Téléphone", 14, "calc", None, "Calculé", f=lambda r, L: f'=IF({L["cle"]}{r}="","",IFERROR(INDEX(Cl_tel,MATCH({L["cle"]}{r},Cl_cle,0))&"",""))'),
        Col("potentiel", "Potentiel / jour", 11, "calc", "General", "Calculé", f=lambda r, L: f'=IF({L["cle"]}{r}="","",IFERROR(INDEX(Cl_potentiel,MATCH({L["cle"]}{r},Cl_cle,0)),""))', align="center"),
        Col("realise", "Réalisé ?", 12, "calc", None, "Selon les visites sur place saisies", f=lambda r, L: (
            f'=IF({L["cle"]}{r}="","",IF({L["jour"]}{r}<>"",IF(COUNTIFS(VC_cle,{L["cle"]}{r},VC_type,"{VISITE_SUR_PLACE}",VC_date,{L["jour"]}{r})>0,"Visité",IF({L["jour"]}{r}<TODAY(),"Non fait","À venir")),'
            f'IF({L["mois"]}{r}="","",IF(COUNTIFS(VC_cle,{L["cle"]}{r},VC_type,"{VISITE_SUR_PLACE}",VC_date,">="&{L["moisref"]}{r},'
            f'VC_date,"<"&DATE(YEAR({L["moisref"]}{r}),MONTH({L["moisref"]}{r})+1,1))>0,"Visité","À visiter"))))'
        ), align="center"),
    ]
    return Journal(
        nom="Planning",
        titre="PLANNING DES VISITES — semaine par semaine",
        sous_titre="Préparez vos tournées : une ligne par client à visiter. « Réalisé ? » se met à jour tout seul d'après vos visites saisies.",
        prefixe="Pl",
        cols=cols,
        lignes=NB_PLANNING,
        onglet="portefeuille",
        gel="D6",
        cle="client",
        entite_cible="(planification, hors modèle)",
    )


# --- Visites et contacts --------------------------------------------------------------------------------------------


def journal_visites() -> Journal:
    cols = [
        col_num(),
        col_ref("date", "V"),
        Col("date", "Date", 16, "in", FMT_DATE, "Liste de dates (aujourd'hui en tête)", req=True, dv={"type": "date_passee"}, align="center", date=True, tgt="crm.visits.occurred_at / crm.interactions.occurred_at"),
        Col("heure", "Heure", 9, "in", FMT_HEURE, "Liste d'heures", dv={"type": "heure"}, align="center", tgt="(heure de l'occurred_at)"),
        Col("type", "Type de contact", 18, "in", None, "Sur place, appel…", req=True, dv={"type": "liste", "nom": "L_TypeContact"}, tgt="visite sur place : crm.visits ; autre : crm.interactions.channel"),
        Col("client", "Client / prospect", 38, "in", None, "Tapez les premières lettres ou ouvrez la liste", req=True, dv={"type": "liste", "nom": "L_Clients"}, tgt="crm.visits.customer_id"),
        Col("objet", "Objet du contact", 28, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_ObjetVisite"}, tgt="crm.visits.notes (objet)"),
        Col("resultat", "Résultat", 22, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_Resultat"}, tgt="crm.visits.outcome_reason_code_id (VISIT_OUTCOME)"),
        Col("concurrent", "Fournisseur actuel / concurrent", 24, "in", None, "Veille marché", tgt="(veille concurrentielle)"),
        Col("prixconc", "Prix concurrent constaté (XAF)", 14, "in", FMT_XAF, "Veille marché", dv={"type": "nombre", "min": 0}, tgt="(veille concurrentielle)"),
        Col("actiondate", "Prochaine action : date", 16, "in", FMT_DATE, "Remplace l'action précédente du client", dv={"type": "date_avenir"}, align="center", date=True, tgt="crm.visits.next_action_at"),
        Col("actiontexte", "Prochaine action : à faire", 28, "in", None, "Ex. rappeler jeudi", tgt="crm.visits.next_action_note"),
        Col("lat", "Latitude", 11, "in", FMT_GPS, "Facultatif", tgt="crm.visits.lat"),
        Col("lng", "Longitude", 11, "in", FMT_GPS, "Facultatif", tgt="crm.visits.lng"),
        Col("notes", "Notes", 36, "in", None, "Libre", tgt="crm.visits.notes"),
        col_commercial("date"),
        *cols_client("client", "commercial"),
        col_quartier_client(),
        col_semaine("date"),
    ]
    return Journal(
        nom="Visites_Contacts",
        titre="VISITES ET CONTACTS — journal du terrain",
        sous_titre="Une ligne par visite sur place ou par appel / message. Choisissez la date, l'heure et le client dans les listes ; ajoutez d'abord un nouveau prospect dans « Clients ».",
        prefixe="VC",
        cols=cols,
        lignes=NB_VISITES,
        onglet="quotidien",
        gel="F6",
        cle="date",
        entite_cible="crm.visits / crm.interactions",
    )


# --- Commandes et ventes -----------------------------------------------------------------------------------------------


def journal_commandes() -> Journal:
    def statut(r, L):
        return (
            f'=IF({L["date"]}{r}="","",IF({L["annulee"]}{r}="{OUI}","{CMD_ANNULEE}",'
            f'IF(OR({L["type"]}{r}="{OP_VENTE_DIRECTE}",{L["livreelle"]}{r}<>""),"{CMD_LIVREE}",'
            f'IF({L["livprevue"]}{r}<>"","{CMD_CONFIRMEE}","{CMD_ATTENTE}"))))'
        )

    def bon(r, L):
        if r == 6:
            return f'=IF({L["grp"]}{r}="","","C"&TEXT(1,"0000"))'
        return (
            f'=IF({L["grp"]}{r}="","",IF({L["premiere"]}{r}=1,"C"&TEXT(SUM({L["premiere"]}$6:{L["premiere"]}{r}),"0000"),'
            f'INDEX({L["bon"]}$6:{L["bon"]}{r - 1},MATCH({L["grp"]}{r},{L["grp"]}$6:{L["grp"]}{r - 1},0))))'
        )

    cols = [
        col_num(),
        col_ref("date", "C"),
        Col("date", "Date de la commande", 16, "in", FMT_DATE, "Liste de dates (aujourd'hui en tête)", req=True, dv={"type": "date_passee"}, align="center", date=True, tgt="sales.sales_orders.occurred_at / sales.sales.occurred_at"),
        Col("client", "Client", 38, "in", None, "Tapez les premières lettres ou ouvrez la liste", req=True, dv={"type": "liste", "nom": "L_Clients"}, tgt="customer_id"),
        Col("type", "Type", 14, "in", None, "Précommande, commande, vente directe", req=True, dv={"type": "liste", "nom": "L_TypeOp"}, tgt="commande (sales_orders) ou vente directe (sales)"),
        Col("produit", "Produit", 30, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_Produit"}, tgt="…_lines.product_id"),
        Col("qte", "Quantité", 10, "in", "General", "Liste (ou autre nombre)", req=True, dv={"type": "quantite"}, align="right", tgt="…_lines.quantity"),
        Col("pu", "Prix convenu (XAF) si différent du prix de référence", 15, "in", FMT_XAF, "Laisser vide = prix de référence", req_si=lambda L: f'AND({L["produit"]}6<>"",{L["prix"]}6="")', dv={"type": "nombre", "min": 0}, tgt="…_lines.unit_price_xaf"),
        Col("remise", "Remise (XAF)", 11, "in", FMT_XAF, "Sur la ligne", dv={"type": "remise"}, tgt="…_lines.discount_xaf"),
        Col("livprevue", "Livraison prévue", 16, "in", FMT_DATE, "Liste de dates", dv={"type": "date_avenir"}, align="center", date=True, tgt="sales.sales_orders.requested_delivery_date"),
        Col("livreelle", "Livraison réelle", 16, "in", FMT_DATE, "Liste de dates", dv={"type": "date_passee"}, align="center", date=True, tgt="sales.delivery_notes.occurred_at"),
        Col("annulee", "Annulée ?", 11, "in", None, "Liste", dv={"type": "liste", "nom": "L_OuiNon"}, align="center", tgt="status = CANCELLED"),
        Col("paiement", "Paiement prévu", 16, "in", None, "Liste", dv={"type": "liste", "nom": "L_PaiementPrevu"}),
        Col("docref", "Réf. du bon ou de la facture papier", 18, "in", FMT_TEXTE, "Facultatif"),
        Col("obs", "Observations", 32, "in", None, "Libre"),
        col_commercial("date"),
        # --- calculs ---
        Col("bon", "N° de commande (automatique)", 13, "calc", None, "Mêmes client + date + type = même commande", f=bon, align="center", tgt="(regroupe les lignes d'une même commande)"),
        Col("statut", "Statut (automatique)", 13, "calc", None, "Calculé d'après les dates", f=statut, align="center", tgt="status"),
        col_unite(),
        Col("prixref", "Prix de référence (XAF)", 13, "calc", FMT_XAF, "Vient de la feuille Listes", f=lambda r, L: prix_reference("produit", r, L)),
        Col("prix", "Prix appliqué (XAF)", 13, "calc", FMT_XAF, "Prix convenu, sinon référence", f=lambda r, L: f'=IF({L["pu"]}{r}<>"",{L["pu"]}{r},{L["prixref"]}{r})'),
        Col("montant", "Montant de la ligne (XAF)", 15, "calc", FMT_XAF, "Quantité × prix − remise", f=lambda r, L: f'=IF(OR({L["qte"]}{r}="",{L["prix"]}{r}=""),"",{L["qte"]}{r}*{L["prix"]}{r}-N({L["remise"]}{r}))'),
        *cols_client("client", "commercial"),
        col_quartier_client(),
        Col("dateca", "Date du CA", 12, "calc", FMT_DATE_ZERO_CACHE, "Quand la vente est réalisée", f=lambda r, L: (
            f'=IF({L["statut"]}{r}<>"{CMD_LIVREE}",0,IF({L["livreelle"]}{r}<>"",{L["livreelle"]}{r},{L["date"]}{r}))'
        ), align="center"),
        Col("grp", "Regroupement", 14, "calc", None, "Technique", f=lambda r, L: (
            f'=IF(OR({L["date"]}{r}="",{L["numclient"]}{r}=""),"",{L["commercial"]}{r}&"|"&{L["numclient"]}{r}&"|"&{L["date"]}{r}&"|"&{L["type"]}{r})'
        ), cache=True),
        Col("premiere", "1re ligne de la commande", 11, "calc", FMT_ENTIER, "Technique", f=lambda r, L: (
            f'=IF({L["grp"]}{r}="","",IF(COUNTIF({L["grp"]}$6:{L["grp"]}{r},{L["grp"]}{r})=1,1,0))'
        ), align="center", cache=True),
        Col("venteunique", "1re ligne de la vente", 11, "calc", FMT_ENTIER, "Technique", f=lambda r, L: (
            f'=IF({L["dateca"]}{r}=0,"",IF(COUNTIFS({L["cle"]}$6:{L["cle"]}{r},{L["cle"]}{r},{L["dateca"]}$6:{L["dateca"]}{r},{L["dateca"]}{r})=1,1,0))'
        ), align="center", cache=True),
        col_semaine("date"),
    ]
    return Journal(
        nom="Commandes",
        titre="COMMANDES ET VENTES — une ligne par produit",
        sous_titre="Précommandes, commandes et ventes directes. Une commande de 3 produits = 3 lignes (mêmes client, date et type) : le numéro, le statut, le prix et le montant se calculent seuls.",
        prefixe="Cmd",
        cols=cols,
        lignes=NB_COMMANDES,
        onglet="quotidien",
        gel="F6",
        cle="date",
        entite_cible="sales.sales_orders / sales.sales",
    )


# --- Encaissements -----------------------------------------------------------------------------------------------------


def journal_encaissements() -> Journal:
    cols = [
        col_num(),
        col_ref("date", "E"),
        Col("date", "Date", 16, "in", FMT_DATE, "Liste de dates (aujourd'hui en tête)", req=True, dv={"type": "date_passee"}, align="center", date=True, tgt="sales.customer_payments.occurred_at"),
        Col("client", "Client", 38, "in", None, "Tapez les premières lettres ou ouvrez la liste", req=True, dv={"type": "liste", "nom": "L_Clients"}, tgt="customer_id"),
        Col("montant", "Montant encaissé (XAF)", 15, "in", FMT_XAF, "Entier", req=True, dv={"type": "positif"}, tgt="amount_xaf"),
        Col("mode", "Mode de paiement", 16, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_Paiement"}, tgt="method_code"),
        Col("reference", "Référence de la transaction", 22, "in", FMT_TEXTE, "Obligatoire hors espèces", req_si=lambda L: f'AND({L["mode"]}6<>"",{L["mode"]}6<>"{ESPECES}",{L["reference"]}6="")', tgt="reference"),
        Col("recu", "Reçu remis au client ?", 12, "in", None, "Liste", dv={"type": "liste", "nom": "L_OuiNon"}, align="center"),
        Col("dateverse", "Date du versement à l'entreprise", 16, "in", FMT_DATE, "Vide tant que non versé", dv={"type": "date_passee"}, align="center", date=True, tgt="finance.cash_transfers (remise de fonds)"),
        Col("refverse", "Réf. du versement", 18, "in", FMT_TEXTE, "Bordereau, reçu…"),
        Col("obs", "Observations", 32, "in", None, "Libre"),
        col_commercial("date"),
        Col("verse", "Versé ? (automatique)", 12, "calc", None, "Espèces : Oui dès qu'une date de versement est saisie", f=lambda r, L: (
            f'=IF(OR({L["date"]}{r}="",{L["mode"]}{r}=""),"",IF({L["mode"]}{r}<>"{ESPECES}","—",IF({L["dateverse"]}{r}<>"","{OUI}","{NON}")))'
        ), align="center"),
        *cols_client("client", "commercial"),
        Col("resteclient", "Reste dû par le client (XAF)", 15, "calc", FMT_XAF, "Après tous ses paiements", f=lambda r, L: f'=IF({L["cle"]}{r}="","",IFERROR(INDEX(Cl_reste,MATCH({L["cle"]}{r},Cl_cle,0)),""))'),
        col_semaine("date"),
    ]
    return Journal(
        nom="Encaissements",
        titre="ENCAISSEMENTS — argent reçu des clients",
        sous_titre="Une ligne par paiement reçu. Quand vous versez l'argent à l'entreprise, choisissez la date du versement : le rapport vous dit combien d'espèces vous détenez encore.",
        prefixe="Enc",
        cols=cols,
        lignes=NB_ENCAISSEMENTS,
        onglet="quotidien",
        gel="F6",
        cle="date",
        entite_cible="sales.customer_payments",
    )


# --- Stock confié ----------------------------------------------------------------------------------------------------------


def journal_stock() -> Journal:
    def valeur(r, L):
        return (
            f'=IF(OR({L["mouvement"]}{r}="",{L["qte"]}{r}=""),"",IF(OR({L["mouvement"]}{r}="{MV_CASSE}",{L["mouvement"]}{r}="{MV_PERTE}",{L["mouvement"]}{r}="{MV_ECHANTILLON}"),'
            f'IF({L["valeursaisie"]}{r}<>"",{L["valeursaisie"]}{r},IF({L["prixref"]}{r}="","",{L["qte"]}{r}*{L["prixref"]}{r})),""))'
        )

    cols = [
        col_num(),
        col_ref("date", "S"),
        Col("date", "Date", 16, "in", FMT_DATE, "Liste de dates (aujourd'hui en tête)", req=True, dv={"type": "date_passee"}, align="center", date=True, tgt="occurred_at"),
        Col("mouvement", "Mouvement", 20, "in", None, "Reçu, retour, casse…", req=True, dv={"type": "liste", "nom": "L_Mouvement"}, tgt="inventory.stock_moves / loss_declarations"),
        Col("produit", "Produit", 30, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_Produit"}, tgt="product_id"),
        Col("qte", "Quantité", 10, "in", "General", "Liste (ou autre nombre)", req=True, dv={"type": "quantite"}, align="right", tgt="quantity"),
        Col("cause", "Cause (casse, perte)", 32, "in", None, "Liste", req_si=lambda L: f'AND(OR({L["mouvement"]}6="{MV_CASSE}",{L["mouvement"]}6="{MV_PERTE}"),{L["cause"]}6="")', dv={"type": "liste", "nom": "L_Cause"}, tgt="reason_code_id (LOSS)"),
        Col("photo", "Photo prise ?", 11, "in", None, "Obligatoire pour une casse", req_si=lambda L: f'AND({L["mouvement"]}6="{MV_CASSE}",{L["photo"]}6="")', dv={"type": "liste", "nom": "L_OuiNon"}, align="center", tgt="attachments (photo obligatoire pour une casse)"),
        Col("valeursaisie", "Valeur estimée (XAF) si différente du calcul", 15, "in", FMT_XAF, "Vide = quantité × prix de référence", dv={"type": "nombre", "min": 0}),
        Col("doc", "N° du bon de sortie / de retour", 20, "in", FMT_TEXTE, "Document du magasin"),
        Col("obs", "Observations", 32, "in", None, "Libre"),
        col_commercial("date"),
        col_unite(),
        Col("prixref", "Prix de référence (XAF)", 13, "calc", FMT_XAF, "Vient de la feuille Listes", f=lambda r, L: prix_reference("produit", r, L)),
        Col("valeur", "Valeur de la casse / perte (XAF)", 15, "calc", FMT_XAF, "Calculée", f=valeur),
        Col("effet", "Effet sur mon stock", 12, "calc", "General", "+ entrée / − sortie", f=lambda r, L: (
            f'=IF(OR({L["mouvement"]}{r}="",{L["qte"]}{r}=""),"",{L["qte"]}{r}*IF(OR({L["mouvement"]}{r}="{MV_RECU}",{L["mouvement"]}{r}="{MV_AJUST_PLUS}"),1,-1))'
        ), align="right"),
        col_semaine("date"),
    ]
    return Journal(
        nom="Stock",
        titre="STOCK CONFIÉ — ce que je reçois, rends ou perds",
        sous_titre="Notez la marchandise reçue du magasin, les retours, les casses et les pertes (photo obligatoire pour une casse). Les ventes se déduisent toutes seules depuis « Commandes ».",
        prefixe="Stk",
        cols=cols,
        lignes=NB_STOCK,
        onglet="ponctuel",
        gel="F6",
        cle="date",
        entite_cible="inventory.stock_moves / inventory.loss_declarations",
    )


# --- Journal du jour -------------------------------------------------------------------------------------------------------------


def journal_journal() -> Journal:
    def kpi(formule):
        return lambda r, L: f'=IF({L["date"]}{r}="","",{formule(r, L)})'

    def jour(r, L):
        return f'{L["date"]}{r}'

    cols = [
        Col("date", "Date", 16, "in", FMT_DATE, "Liste de dates (aujourd'hui en tête)", req=True, dv={"type": "date_passee"}, align="center", date=True, tgt="fieldwork.work_sessions.work_date"),
        col_commercial("date"),
        Col("jour", "Jour", 11, "calc", None, "Calculé", f=lambda r, L: f'=IF({L["date"]}{r}="","",CHOOSE(WEEKDAY({L["date"]}{r},2),"Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"))', align="center"),
        col_semaine("date"),
        Col("debut", "Prise de service (heure)", 11, "in", FMT_HEURE, "Liste d'heures", dv={"type": "heure"}, align="center", tgt="fieldwork.geo_checkins (START_SERVICE)"),
        Col("fin", "Fin de service (heure)", 11, "in", FMT_HEURE, "Liste d'heures", dv={"type": "heure"}, align="center", tgt="fieldwork.geo_checkins (END_SERVICE)"),
        Col("zone", "Zone / quartier du jour", 20, "in", None, "Liste", dv={"type": "liste", "nom": "L_Zone", "souple": True}, tgt="fieldwork.work_sessions.declared_zone_id"),
        Col("frais", "Frais engagés (XAF)", 13, "in", FMT_XAF, "Liste (ou autre montant)", dv={"type": "frais"}),
        Col("amplitude", "Durée (h)", 9, "calc", "0.0", "Calculé", f=lambda r, L: f'=IF(OR({L["debut"]}{r}="",{L["fin"]}{r}=""),"",ROUND(({L["fin"]}{r}-{L["debut"]}{r})*24,1))', align="center"),
        Col("visites", "Visites sur place", 10, "calc", FMT_ENTIER, "Depuis Visites_Contacts", f=kpi(lambda r, L: k_visites(jour(r, L), jour(r, L), f'{L["commercial"]}{r}')), align="center"),
        Col("contacts", "Contacts à distance", 10, "calc", FMT_ENTIER, "Appels, messages", f=kpi(lambda r, L: k_contacts(jour(r, L), jour(r, L), f'{L["commercial"]}{r}')), align="center"),
        Col("prospects", "Nouveaux prospects", 10, "calc", FMT_ENTIER, "Depuis Clients", f=kpi(lambda r, L: k_prospects(jour(r, L), jour(r, L), f'{L["commercial"]}{r}')), align="center"),
        Col("nvxclients", "Nouveaux clients", 10, "calc", FMT_ENTIER, "1ère vente ce jour", f=kpi(lambda r, L: k_nouveaux_clients(jour(r, L), jour(r, L), f'{L["commercial"]}{r}')), align="center"),
        Col("cmdnb", "Commandes prises (nb)", 13, "calc", FMT_ENTIER, "Hors ventes directes", f=kpi(lambda r, L: k_commandes_nb(jour(r, L), jour(r, L), f'{L["commercial"]}{r}')), align="center"),
        Col("cmdval", "Commandes prises (XAF)", 14, "calc", FMT_XAF, "Valeur", f=kpi(lambda r, L: k_commandes_xaf(jour(r, L), jour(r, L), f'{L["commercial"]}{r}'))),
        Col("ca", "CA réalisé (XAF)", 14, "calc", FMT_XAF, "Livré / vendu ce jour", f=kpi(lambda r, L: k_ca(jour(r, L), jour(r, L), f'{L["commercial"]}{r}'))),
        Col("encaisse", "Encaissé (XAF)", 14, "calc", FMT_XAF, "Depuis Encaissements", f=kpi(lambda r, L: k_encaisse(jour(r, L), jour(r, L), f'{L["commercial"]}{r}'))),
        Col("casses", "Casses et pertes (XAF)", 13, "calc", FMT_XAF, "Depuis Stock", f=kpi(lambda r, L: k_casses(jour(r, L), jour(r, L), f'{L["commercial"]}{r}'))),
        Col("forts", "Réussites du jour", 36, "in", None, "Ce qui a bien marché", tgt="communication.internal_notes"),
        Col("difficultes", "Difficultés rencontrées", 36, "in", None, "Blocages, refus, retards"),
        Col("soutien", "Besoin de soutien (direction)", 32, "in", None, "Ce dont vous avez besoin"),
        Col("demain", "Plan du lendemain", 36, "in", None, "Zones, clients, objectifs"),
    ]
    return Journal(
        nom="Journal",
        titre="JOURNAL DU COMMERCIAL — mon rapport de chaque jour",
        sous_titre="Une ligne par jour travaillé : choisissez la date et les heures dans les listes, puis le bilan en quelques mots. Les chiffres du jour se calculent seuls ; le rapport imprimable est dans « Rapport_Jour ».",
        prefixe="Jr",
        cols=cols,
        lignes=NB_JOURNAL,
        onglet="quotidien",
        gel="C6",
        cle="date",
        entite_cible="fieldwork.work_sessions / communication.internal_notes",
    )


# --- Objectifs --------------------------------------------------------------------------------------------------------------------


def journal_objectifs() -> Journal:
    cols = [
        col_num(),
        Col("commercial", "Commercial", 13, "calc", None, "Rempli seul ; remplaçable", f=lambda r, L: f'=IF({L["metrique"]}{r}="","",Commercial_Id)', tgt="crm.sales_targets.user_id"),
        Col("metrique", "Indicateur", 30, "in", None, "Liste", req=True, dv={"type": "liste", "nom": "L_Metrique"}, tgt="crm.sales_targets.metric"),
        Col("produit", "Produit (si quantité)", 30, "in", None, "Liste", req_si=lambda L: f'AND({L["metrique"]}6="{M_QTE}",{L["produit"]}6="")', dv={"type": "liste", "nom": "L_Produit"}, tgt="crm.sales_targets.product_id"),
        Col("periode", "Période", 12, "in", None, "Semaine ou mois", req=True, dv={"type": "liste", "nom": "L_TypePeriode"}, align="center"),
        Col(
            "debut", "Début de la période", 16, "in", FMT_DATE, "Lundi (semaine) ou 1er du mois", req=True,
            dv=lambda L: {"type": "liste_formule", "formule": f'=INDIRECT(IF(${L["periode"]}6="{P_MOIS}","L_Mois","L_LundisAvenir"))'},
            align="center", date=True, tgt="crm.sales_targets.period_start",
        ),
        Col("valeur", "Valeur cible", 14, "in", "[<1000]General;#,##0", "Nombre à atteindre", req=True, dv={"type": "positif"}, tgt="crm.sales_targets.target_value"),
        Col("commentaire", "Commentaire", 36, "in", None, "Libre"),
        Col("fin", "Fin de la période", 14, "calc", FMT_DATE, "Calculée", f=lambda r, L: (
            f'=IF(OR({L["periode"]}{r}="",{L["debut"]}{r}=""),"",IF({L["periode"]}{r}="{P_MOIS}",DATE(YEAR({L["debut"]}{r}),MONTH({L["debut"]}{r})+1,0),{L["debut"]}{r}+6))'
        ), align="center", tgt="crm.sales_targets.period_end"),
        Col("duree", "Durée (jours)", 9, "calc", FMT_ENTIER, "Calculée : ≤ 7 = objectif de semaine", f=lambda r, L: f'=IF(OR({L["debut"]}{r}="",{L["fin"]}{r}=""),"",{L["fin"]}{r}-{L["debut"]}{r}+1)', align="center"),
    ]
    return Journal(
        nom="Objectifs",
        titre="OBJECTIFS — ce que je dois atteindre",
        sous_titre="Une ligne par objectif et par période : choisissez l'indicateur, « Semaine » ou « Mois », le début dans la liste et la valeur. La fin se calcule seule.",
        prefixe="Obj",
        cols=cols,
        lignes=NB_OBJECTIFS,
        onglet="ponctuel",
        gel="D6",
        cle="metrique",
        entite_cible="crm.sales_targets",
    )


# --- Bilans hebdomadaires -------------------------------------------------------------------------------------------------------------


def journal_bilans() -> Journal:
    def kpi(formule):
        return lambda r, L: f'=IF({L["lundi"]}{r}="","",{formule(r, L)})'

    def fin(r, L):
        return f'{L["lundi"]}{r}+6'

    cols = [
        Col("lundi", "Lundi de la semaine", 16, "in", FMT_DATE, "Liste des lundis", req=True, dv={"type": "lundi_passe"}, align="center", date=True),
        Col("commercial", "Commercial", 13, "calc", None, "Rempli seul ; remplaçable", f=lambda r, L: f'=IF({L["lundi"]}{r}="","",Commercial_Id)'),
        col_semaine("lundi"),
        Col("visites", "Visites sur place", 10, "calc", FMT_ENTIER, "Calculé", f=kpi(lambda r, L: k_visites(f'{L["lundi"]}{r}', fin(r, L), f'{L["commercial"]}{r}')), align="center"),
        Col("nvxclients", "Nouveaux clients", 10, "calc", FMT_ENTIER, "Calculé", f=kpi(lambda r, L: k_nouveaux_clients(f'{L["lundi"]}{r}', fin(r, L), f'{L["commercial"]}{r}')), align="center"),
        Col("ca", "CA réalisé (XAF)", 14, "calc", FMT_XAF, "Calculé", f=kpi(lambda r, L: k_ca(f'{L["lundi"]}{r}', fin(r, L), f'{L["commercial"]}{r}'))),
        Col("encaisse", "Encaissé (XAF)", 14, "calc", FMT_XAF, "Calculé", f=kpi(lambda r, L: k_encaisse(f'{L["lundi"]}{r}', fin(r, L), f'{L["commercial"]}{r}'))),
        Col("reussites", "Réussites de la semaine", 44, "in", None, "Ce qui a bien marché", tgt="communication.internal_notes"),
        Col("difficultes", "Difficultés rencontrées", 44, "in", None, "Blocages, refus, retards"),
        Col("besoins", "Besoins / demandes à la direction", 40, "in", None, "Support, stock, prix, outils…"),
        Col("priorites", "Priorités de la semaine suivante", 44, "in", None, "3 priorités maximum"),
        Col("marche", "Infos marché (concurrents, prix, tendances)", 44, "in", None, "Veille terrain"),
        Col("valide", "Vu par le responsable ?", 12, "in", None, "Liste", dv={"type": "liste", "nom": "L_OuiNon"}, align="center"),
        Col("comresp", "Commentaire du responsable", 44, "in", None, "Retour au commercial"),
    ]
    return Journal(
        nom="Bilans_Hebdo",
        titre="BILANS HEBDOMADAIRES — le texte du rapport de la semaine",
        sous_titre="Une ligne par semaine : choisissez le lundi dans la liste puis écrivez le bilan. Les chiffres de la semaine se calculent seuls ; le rapport complet est dans « Rapport_Semaine ».",
        prefixe="Bil",
        cols=cols,
        lignes=NB_BILANS,
        onglet="ponctuel",
        gel="B6",
        cle="lundi",
        entite_cible="communication.internal_notes",
    )
