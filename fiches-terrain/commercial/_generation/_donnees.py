"""Listes de référence et données reprises de la fiche « ETAT DEPLOIEMENT SEPTEMBRE » (hors tableau SIM, à ignorer).

Les libellés sont ceux que voit le commercial ; le second élément de chaque couple est un code
**indicatif** de l'application cible (CRM, ventes, stock), repris du dictionnaire de données du projet
quand il existe. Les listes se complètent à la suite, dans la feuille « Listes ».
"""

from __future__ import annotations

# --- Libellés réutilisés dans les formules (une seule source) ---------------------------------------------------
VISITE_SUR_PLACE = "Visite sur place"
ST_PROSPECT = "Prospect"
ST_CLIENT = "Client"
ST_PERDU = "Perdu"
OP_PRECOMMANDE = "Précommande"
OP_COMMANDE = "Commande"
OP_VENTE_DIRECTE = "Vente directe"
CMD_LIVREE = "Livrée"
CMD_ANNULEE = "Annulée"
CMD_ATTENTE = "En attente"
CMD_CONFIRMEE = "Confirmée"
ESPECES = "Espèces"
MV_RECU = "Reçu du magasin"
MV_RETOUR = "Retourné au magasin"
MV_CASSE = "Casse / avarie"
MV_PERTE = "Perte / vol"
MV_ECHANTILLON = "Échantillon offert"
MV_AJUST_PLUS = "Ajustement (+)"
MV_AJUST_MOINS = "Ajustement (-)"
OUI = "☑ Oui"
NON = "☐ Non"
A_RENSEIGNER = "À RENSEIGNER"

FONCTIONS = [
    ("Commercial terrain", "COMMERCIAL_TERRAIN"),
    ("Commercial sédentaire", "COMMERCIAL_SEDENTAIRE"),
    ("Vendeur de point de vente", "VENDEUR_PDV"),
    ("Responsable commercial", "RESP_COMMERCIAL"),
]

TYPES_CLIENT = [
    ("Restaurant", "RESTAURANT"),
    ("Hôtel", "HOTEL"),
    ("Traiteur / événementiel", "TRAITEUR"),
    ("Revendeur / détaillant de marché", "REVENDEUR"),
    ("Grossiste", "GROSSISTE"),
    ("Boulangerie / pâtisserie", "BOULANGERIE"),
    ("Boutique / supérette / supermarché", "COMMERCE"),
    ("Institution (école, hôpital, entreprise)", "INSTITUTION"),
    ("Particulier / ménage", "PARTICULIER"),
    ("Autre", "AUTRE"),
]
TYPE_PARTICULIER = "Particulier / ménage"

SOURCES = [
    ("Prospection terrain", "PROSPECTION_TERRAIN"),
    ("Recommandation", "RECOMMANDATION"),
    ("Réseau social / WhatsApp", "RESEAU_SOCIAL"),
    ("Visite spontanée / appel entrant", "VISITE_SPONTANEE"),
    ("Autre", "AUTRE"),
]

STATUTS = [(ST_PROSPECT, "PROSPECT"), (ST_CLIENT, "CUSTOMER"), (ST_PERDU, "LOST")]

ETAPES = [
    ("Nouveau", "NOUVEAU"),
    ("Contacté", "CONTACTE"),
    ("Intéressé", "INTERESSE"),
    ("Négociation", "NEGOCIATION"),
]

TYPES_CONTACT = [
    (VISITE_SUR_PLACE, "VISITE"),
    ("Appel téléphonique", "APPEL"),
    ("WhatsApp / message", "SMS"),
    ("E-mail", "EMAIL"),
    ("Autre", "AUTRE"),
]

OBJETS_VISITE = [
    ("Prospection / découverte", "PROSPECTION"),
    ("Présentation produits et prix", "PRESENTATION"),
    ("Prise de commande", "PRISE_COMMANDE"),
    ("Livraison", "LIVRAISON"),
    ("Encaissement / recouvrement", "ENCAISSEMENT"),
    ("Réclamation / service après-vente", "SAV"),
    ("Fidélisation / suivi", "SUIVI"),
    ("Autre", "AUTRE"),
]

RESULTATS = [
    ("Commande prise", "COMMANDE_PRISE"),
    ("À relancer", "A_RELANCER"),
    ("Rendez-vous fixé", "RDV_FIXE"),
    ("Pas intéressé", "PAS_INTERESSE"),
    ("Absent / fermé", "ABSENT"),
    ("Livraison effectuée", "LIVRAISON_FAITE"),
    ("Paiement encaissé", "PAIEMENT_RECU"),
    ("Réclamation traitée", "RECLAMATION"),
    ("Autre", "AUTRE"),
]

MOTIFS_PERTE = [
    ("Pas intéressé", "PAS_INTERESSE"),
    ("Prix trop élevé", "PRIX"),
    ("Garde son fournisseur habituel", "FOURNISSEUR_HABITUEL"),
    ("Besoin trop faible", "BESOIN_FAIBLE"),
    ("Injoignable / introuvable", "INJOIGNABLE"),
    ("Établissement fermé", "FERME"),
    ("Qualité / calibre non adapté", "QUALITE"),
    ("Autre", "AUTRE"),
]

# Produits : (libellé, unité, prix de référence XAF, code indicatif). Le prix reste VIDE : il est fixé par la
# direction (grille tarifaire), pas par le modèle.
PRODUITS = [
    ("Œufs frais - alvéole de 30", "Alvéole", None, "OEUFS_ALVEOLE_30"),
    ("Poulet de chair entier", "Pièce", None, "POULET_ENTIER"),
    ("Découpes de volaille", "Kg", None, "DECOUPES_VOLAILLE"),
    ("Viande de porc", "Kg", None, "PORC"),
    ("Poussins d'un jour", "Pièce", None, "POUSSIN_1J"),
    ("Alvéoles en carton (vides)", "Lot", None, "ALVEOLES_CARTON"),
    ("Autre produit", "Pièce", None, "AUTRE"),
]

UNITES = [("Alvéole", "ALVEOLE"), ("Pièce", "PIECE"), ("Kg", "KG"), ("Carton", "CARTON"), ("Lot", "LOT")]

PAIEMENTS = [
    (ESPECES, "ESPECES"),
    ("Orange Money", "MOBILE_MONEY_ORANGE"),
    ("MTN MoMo", "MOBILE_MONEY_MTN"),
    ("Virement", "VIREMENT"),
    ("Chèque", "CHEQUE"),
]

TYPES_OPERATION = [
    (OP_PRECOMMANDE, "PRECOMMANDE"),
    (OP_COMMANDE, "COMMANDE"),
    (OP_VENTE_DIRECTE, "VENTE_DIRECTE"),
]

STATUTS_COMMANDE = [
    (CMD_ATTENTE, "EN_ATTENTE"),
    (CMD_CONFIRMEE, "CONFIRMEE"),
    (CMD_LIVREE, "LIVREE"),
    (CMD_ANNULEE, "ANNULEE"),
]

PAIEMENTS_PREVUS = [
    ("À la livraison", "A_LA_LIVRAISON"),
    ("Avance versée", "AVANCE"),
    ("Différé / crédit", "DIFFERE"),
]

MOUVEMENTS_STOCK = [
    (MV_RECU, "RECU"),
    (MV_RETOUR, "RETOUR"),
    (MV_CASSE, "CASSE"),
    (MV_PERTE, "PERTE"),
    (MV_ECHANTILLON, "ECHANTILLON"),
    (MV_AJUST_PLUS, "AJUSTEMENT_PLUS"),
    (MV_AJUST_MOINS, "AJUSTEMENT_MOINS"),
]

CAUSES = [
    ("Œufs fêlés ou cassés au transport", "CASSE_TRANSPORT"),
    ("Avarie de transport", "AVARIE_TRANSPORT"),
    ("Produit périmé / chaîne du froid rompue", "PEREMPTION"),
    ("Retour client refusé", "RETOUR_CLIENT"),
    ("Vol", "VOL"),
    ("Erreur de comptage", "ERREUR_COMPTAGE"),
    ("Autre", "AUTRE"),
]

# Quartiers de Douala : suggestions (la saisie d'un autre quartier reste possible).
ZONES = [
    ("Akwa", ""),
    ("Bonanjo", ""),
    ("Deido", ""),
    ("Bonapriso", ""),
    ("New Bell", ""),
    ("Bépanda", ""),
    ("Makepe", ""),
    ("Bonamoussadi", ""),
    ("Bonabéri", ""),
    ("Ndokoti", ""),
    ("Logbessou", ""),
    ("Logpom", ""),
    ("Beedi", ""),
    ("Cité des Palmiers", ""),
    ("PK9", ""),
    ("PK10", ""),
    ("PK12", ""),
    ("PK13", ""),
    ("Autre", ""),
]

METRIQUES = [
    ("Chiffre d'affaires (XAF)", "CA"),
    ("Quantité vendue d'un produit", "QTE_PRODUIT"),
    ("Nouveaux clients", "NOUVEAUX_CLIENTS"),
    ("Visites sur place", "VISITES"),
    ("Prospects créés", "PROSPECTS_CREES"),
]
M_CA = "Chiffre d'affaires (XAF)"
M_QTE = "Quantité vendue d'un produit"
M_NVX_CLIENTS = "Nouveaux clients"
M_VISITES = "Visites sur place"
M_PROSPECTS = "Prospects créés"

OUI_NON = [(OUI, ""), (NON, "")]

TYPES_PERIODE = [("Semaine", "SEMAINE"), ("Mois", "MOIS")]
P_SEMAINE = "Semaine"
P_MOIS = "Mois"

# Valeurs proposées dans les listes de quantités, de frais et de remises (d'autres valeurs restent permises).
QUANTITES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 300, 500, 1000]
FRAIS_TYPES = [500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000]
REMISES = [0, 100, 200, 250, 500, 1000, 2000, 5000]
SEMAINES_MOIS = [(1, ""), (2, ""), (3, ""), (4, ""), (5, "")]

# --- Données de la fiche « ETAT DEPLOIEMENT SEPTEMBRE » (commercial, 2 octobre 2026 environ) --------------------
# (potentiel / jour, localisation, téléphone, type d'origine)
MOIS_FICHE = "2026-09"
FICHE_PDV = {
    1: [
        (5, "PK12", "677122395", None),
        (4, "LOGBESSOU FACE UIG", "691366088", None),
        (10, "MARCHE LOGPOM", "691002251", None),
        (5, "LOGBESSOU EGLISE", "672338633", None),
        (7, "PK12", "693434196", None),
        (15, "BLGRIE LA PAIX", "677701241", None),
        (5, "ENTRÉE UIT", "687124842", None),
    ],
    2: [
        (5, "IPH", "695612579", None),
        (5, "SCIERIE NDOGBONG", "683428778", None),
        (10, "HOTEL DOVIL", "656773514", None),
        (5, "FACE 10E", "693936160", None),
        (3, "ENTRÉE HOTEL DOVIL", "694739633", None),
        (2, "CAMLAIT", "655112340", None),
        (9, "HOTEL DOVIL  II", "691875968", None),
    ],
    4: [
        (2, "BEEDI ENTREE MAALAM", "678912047", "RESTO"),
        (2, "TOITURE VERTE", "675851976", "RESTO"),
        (2, "BEEDI ENTREE MAALAM", "671616184", "RESTO"),
        (4, "MOSQUE CITE DES PALMIERS", "699727306", "PARTICULIER"),
        (7, "PK10", "650623291", "PARTICULIER"),
        (3, "HOPITAL GENERAL BEEDI", "698752163", "RESTO"),
        (3, "BEEDI TOTAL", "677887433", "RESTO"),
        (5, "CITE DES PALMIERS", "652534958", "REVENDEUR"),
        (4, "PK13", "679655008", "REVENDEUR"),
        (3, "PK9", "691747845", "PARTICULIER"),
        (5, "BEEDI ENTRE CHARLI", "698124237", "REVENDEUR"),
        (5, "CARREFOUR CONQUETE", "659369295", "REVENDEUR"),
    ],
}

TYPE_FICHE_VERS_TYPE = {
    "RESTO": "Restaurant",
    "PARTICULIER": TYPE_PARTICULIER,
    "REVENDEUR": "Revendeur / détaillant de marché",
}

# Quartier déduit du texte de localisation, seulement quand il est évident (sinon vide).
def quartier_depuis_localisation(localisation: str) -> str:
    texte = localisation.upper()
    regles = [
        ("LOGBESSOU", "Logbessou"),
        ("LOGPOM", "Logpom"),
        ("BEEDI", "Beedi"),
        ("CITE DES PALMIERS", "Cité des Palmiers"),
        ("PK13", "PK13"),
        ("PK12", "PK12"),
        ("PK10", "PK10"),
        ("PK9", "PK9"),
    ]
    for motif, quartier in regles:
        if motif in texte:
            return quartier
    return ""


# --- Mise au propre des lignes de la fiche d'origine --------------------------------------------------------------
# Libellé lisible de chaque localisation (la fiche les écrit en capitales, avec des abréviations).
LOCALISATION_PROPRE = {
    "PK12": "PK12",
    "LOGBESSOU FACE UIG": "Logbessou, face UIG",
    "MARCHE LOGPOM": "Marché Logpom",
    "LOGBESSOU EGLISE": "Logbessou, église",
    "BLGRIE LA PAIX": "La Paix",
    "ENTRÉE UIT": "Entrée UIT",
    "IPH": "IPH",
    "SCIERIE NDOGBONG": "Scierie Ndogbong",
    "HOTEL DOVIL": "Dovil",
    "FACE 10E": "Face 10e",
    "ENTRÉE HOTEL DOVIL": "Entrée hôtel Dovil",
    "CAMLAIT": "Camlait",
    "HOTEL DOVIL II": "Dovil II",
    "BEEDI ENTREE MAALAM": "Beedi, entrée Maalam",
    "TOITURE VERTE": "Toiture Verte",
    "MOSQUE CITE DES PALMIERS": "Mosquée, Cité des Palmiers",
    "PK10": "PK10",
    "HOPITAL GENERAL BEEDI": "Hôpital Général, Beedi",
    "BEEDI TOTAL": "Beedi Total",
    "CITE DES PALMIERS": "Cité des Palmiers",
    "PK13": "PK13",
    "PK9": "PK9",
    "BEEDI ENTRE CHARLI": "Beedi, entrée Charli",
    "CARREFOUR CONQUETE": "Carrefour Conquête",
}

# Type de client quand le libellé d'origine le dit lui-même (sinon « Autre »).
TYPE_DEDUIT_DU_LIBELLE = {
    "HOTEL DOVIL": "Hôtel",
    "ENTRÉE HOTEL DOVIL": "Hôtel",
    "HOTEL DOVIL II": "Hôtel",
    "BLGRIE LA PAIX": "Boulangerie / pâtisserie",
    "MARCHE LOGPOM": "Revendeur / détaillant de marché",
}

# Nom complet imposé pour quelques établissements (le reste : préfixe selon le type + localisation).
NOM_IMPOSE = {
    "HOTEL DOVIL": "Hôtel Dovil",
    "ENTRÉE HOTEL DOVIL": "Hôtel Dovil, entrée",
    "HOTEL DOVIL II": "Hôtel Dovil II",
    "BLGRIE LA PAIX": "Boulangerie La Paix",
    "MARCHE LOGPOM": "Marché Logpom",
}

PREFIXE_NOM = {
    "Restaurant": "Resto",
    "Revendeur / détaillant de marché": "Revendeur",
    "Particulier / ménage": "Particulier",
}

# Premier jour de chaque semaine de ciblage de septembre 2026 (les semaines de la fiche d'origine).
DEBUT_SEMAINE_FICHE = {1: (2026, 9, 1), 2: (2026, 9, 7), 4: (2026, 9, 21)}


def cle_localisation(localisation: str) -> str:
    return " ".join(localisation.split())
