"""
===================================================================================
VÉRIFICATEUR WHATSAPP B2B - SANS ENVOI DE MESSAGE
Projet : GIC AGROPELC - Qualification de la Base Clients & Partenaires
===================================================================================

Principe de fonctionnement :
1. Ouvre Chromium avec une session persistante (dossier 'whatsapp_session').
2. Au 1er lancement, vous scannez le QR code avec votre téléphone (une seule fois).
3. Pour chaque numéro du fichier Excel :
   - Navigue vers 'https://web.whatsapp.com/send?phone=<NUMERO>'
   - Attend la réponse du serveur WhatsApp Web :
     * Si popup 'numéro non valide / non inscrit' -> WhatsApp : NON
     * Si la zone de discussion s'affiche -> WhatsApp : OUI
   - N'ENVOIE STRICTEMENT AUCUN MESSAGE (aucun risque de signalement/blocage).
4. Enregistre le résultat directement dans le fichier Excel (colonne WhatsApp).
5. Sauvegarde automatique après chaque lot de 10 vérifications.

Pré-requis (à exécuter une fois dans le terminal) :
    pip install playwright openpyxl
    playwright install chromium
===================================================================================
"""

import os
import re
import time
import random
import openpyxl
from playwright.sync_api import sync_playwright

# Chemins des fichiers
EXCEL_PATH = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx"
USER_DATA_DIR = os.path.join(os.path.dirname(__file__), "whatsapp_session")

def extraire_chiffres_telephone(phone_str):
    """Extrait uniquement les chiffres d'un numéro international."""
    if not phone_str:
        return None
    digits = re.sub(r'\D', '', str(phone_str))
    # Ex: pour +237 6 99 12 34 56 -> '237699123456'
    if len(digits) >= 8:
        return digits
    return None

def verifier_fichier_excel(max_verifications=None, filtre_pays=None):
    """
    Parcourt le fichier Excel et teste chaque numéro non encore vérifié.
    - max_verifications : limite le nombre de tests par session (ex: 50 ou 100 pour rester discret).
    - filtre_pays : permet de tester un pays spécifique (ex: 'Cameroun' ou 'Guinée équatoriale').
    """
    if not os.path.exists(EXCEL_PATH):
        print(f"[ERREUR] Le fichier Excel n'existe pas : {EXCEL_PATH}")
        return

    print(f"[INFO] Chargement du fichier Excel : {EXCEL_PATH}")
    wb = openpyxl.load_workbook(EXCEL_PATH)
    ws = wb["Base Contacts"]

    # Identifier les colonnes
    headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
    col_pays = headers.index("Pays") + 1
    col_nom = headers.index("Nom de l'Entreprise / Raison Sociale") + 1
    col_phone = headers.index("Téléphone Principal (E.164)") + 1
    col_whatsapp = headers.index("Autre Téléphone / WhatsApp") + 1

    lignes_a_traiter = []
    for r in range(2, ws.max_row + 1):
        pays = ws.cell(r, col_pays).value
        nom = ws.cell(r, col_nom).value
        phone = ws.cell(r, col_phone).value
        whatsapp_actuel = str(ws.cell(r, col_whatsapp).value or '')

        # Si le numéro n'a pas encore été qualifié WhatsApp
        if "WhatsApp :" not in whatsapp_actuel and "WA :" not in whatsapp_actuel:
            chiffres = extraire_chiffres_telephone(phone)
            if chiffres:
                if not filtre_pays or (pays and filtre_pays.lower() in str(pays).lower()):
                    lignes_a_traiter.append({
                        "row": r,
                        "pays": pays,
                        "nom": nom,
                        "phone_format": phone,
                        "digits": chiffres,
                        "whatsapp_col": col_whatsapp
                    })

    total_disponibles = len(lignes_a_traiter)
    print(f"[INFO] Total de fiches prêtes pour vérification WhatsApp : {total_disponibles}")
    if max_verifications:
        lignes_a_traiter = lignes_a_traiter[:max_verifications]
        print(f"[INFO] Session limitée aux {len(lignes_a_traiter)} premiers numéros.")

    if not lignes_a_traiter:
        print("[INFO] Aucun numéro en attente de vérification. Tout est à jour !")
        return

    # Lancement du navigateur Playwright avec profil persistant
    print(f"\n[INFO] Démarrage du navigateur Chromium...")
    print(f"[INFO] Profil de session stocké dans : {USER_DATA_DIR}")

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=False,  # Visible pour permettre de scanner le QR code au premier lancement
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled"
            ]
        )

        page = browser.new_page()
        page.goto("https://web.whatsapp.com")

        print("\n" + "="*70)
        print("ATTENTE DE CONNEXION À WHATSAPP WEB :")
        print("Si vous n'êtes pas connecté, scannez le QR code avec votre WhatsApp.")
        print("Le script attendra que la liste de discussions soit chargée...")
        print("="*70 + "\n")

        # Attendre que WhatsApp Web soit complètement chargé
        # Le sélecteur du volet latéral de recherche ou liste des conversations
        try:
            page.wait_for_selector('div[contenteditable="true"], div[data-tab="3"], #pane-side', timeout=120000)
            print("[SUCCÈS] Session WhatsApp Web active et authentifiée !")
        except Exception:
            print("[ERREUR] Délai d'attente de connexion dépassé (2 minutes). Veuillez relancer.")
            browser.close()
            return

        # Parcourir chaque numéro
        traites = 0
        valides_wa = 0
        invalides_wa = 0

        for item in lignes_a_traiter:
            r = item["row"]
            nom = item["nom"]
            digits = item["digits"]
            phone_fmt = item["phone_format"]

            print(f"\n[{traites + 1}/{len(lignes_a_traiter)}] Test : {nom} ({phone_fmt} -> {digits})...")

            # Naviguer vers l'URL de contact
            url_test = f"https://web.whatsapp.com/send?phone={digits}"
            page.goto(url_test)

            statut_wa = None
            start_time = time.time()

            # Observer l'état pendant max 15 secondes
            while time.time() - start_time < 15:
                # 1. Vérifier si la popup "Numéro de téléphone non valide" apparaît
                popup_erreur = page.query_selector('div[data-animate-modal-body="true"], div[role="dialog"]')
                if popup_erreur:
                    texte_popup = popup_erreur.inner_text().lower()
                    if any(mot in texte_popup for mot in ["non valide", "invalid", "n'est pas enregistré", "not on whatsapp"]):
                        statut_wa = False
                        # Cliquer sur OK pour fermer la popup
                        bouton_ok = page.query_selector('div[role="dialog"] button, div[role="dialog"] div[role="button"]')
                        if bouton_ok:
                            try: bouton_ok.click()
                            except: pass
                        break

                # 2. Vérifier si la zone de message est apparue (numéro valide sur WhatsApp)
                champ_message = page.query_selector('footer div[contenteditable="true"], div[data-tab="10"]')
                en_tete_contact = page.query_selector('header div[role="button"]')
                if champ_message or en_tete_contact:
                    # Ne rien taper, ne rien envoyer !
                    statut_wa = True
                    break

                page.wait_for_timeout(1000)

            # Traitement du résultat
            if statut_wa is True:
                valides_wa += 1
                resultat_texte = f"WA : OUI ({digits})"
                print(f"  -> RÉSULTAT : [OUI] Numéro actif sur WhatsApp !")
            elif statut_wa is False:
                invalides_wa += 1
                resultat_texte = f"WA : NON"
                print(f"  -> RÉSULTAT : [NON] Aucun compte WhatsApp sur ce numéro.")
            else:
                # Timeout ou réseau lent
                resultat_texte = f"WA : À RE-TESTER"
                print(f"  -> RÉSULTAT : [INDÉTERMINÉ] Délai dépassé.")

            # Mettre à jour la cellule Excel
            curr_val = str(ws.cell(r, col_whatsapp).value or '').strip()
            if curr_val and curr_val != 'None':
                ws.cell(r, col_whatsapp, value=f"{curr_val} | {resultat_texte}")
            else:
                ws.cell(r, col_whatsapp, value=resultat_texte)

            traites += 1

            # Sauvegarde intermédiaire tous les 10 numéros
            if traites % 10 == 0:
                wb.save(EXCEL_PATH)
                print(f"[SAUVEGARDE] Fichier Excel mis à jour ({traites} numéros traités).")

            # Pause aléatoire de sécurité entre 2 et 4 secondes pour respecter la politique de WhatsApp
            delai = random.uniform(2.5, 4.5)
            time.sleep(delai)

        # Sauvegarde finale
        wb.save(EXCEL_PATH)
        print("\n" + "="*70)
        print(f"SESSION TERMINÉE AVEC SUCCÈS !")
        print(f"Total testés : {traites}")
        print(f"Comptes WhatsApp actifs détectés : {valides_wa}")
        print(f"Comptes inexistants sur WhatsApp : {invalides_wa}")
        print(f"Classeur Excel mis à jour : {EXCEL_PATH}")
        print("="*70)

        browser.close()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Vérificateur WhatsApp Web sans envoi de message pour GIC AGROPELC")
    parser.add_argument("--limite", type=int, default=50, help="Nombre maximal de numéros à tester dans cette session (ex: 50 ou 100)")
    parser.add_argument("--pays", type=str, default=None, help="Filtrer par pays (ex: Cameroun, Gabon, Guinée équatoriale)")
    args = parser.parse_args()

    verifier_fichier_excel(max_verifications=args.limite, filtre_pays=args.pays)
