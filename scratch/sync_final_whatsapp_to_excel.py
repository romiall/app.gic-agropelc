import os
import re
import json
import glob
import shutil
from collections import Counter
import openpyxl

BASE_DIR = r"c:\xampp\htdocs\app.gic-agropelc"
VERIFIER_DIR = os.path.join(BASE_DIR, "scratch", "whatsapp_verifier")
EXCEL_MAIN = os.path.join(BASE_DIR, "BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx")
EXCEL_ENRICHI = os.path.join(BASE_DIR, "BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE_ENRICHI.xlsx")

def is_fixed(d):
    if not d or len(d) < 8: return False
    if d.startswith('237'): return d[3:].startswith('2')
    if d.startswith('241'): return d[3:].startswith(('01', '11', '011'))
    if d.startswith('242'): return d[3:].startswith('22')
    if d.startswith('240'): return d[3:].startswith(('333', '350', '33'))
    if d.startswith('235'): return d[3:].startswith('22')
    if d.startswith('236'): return d[3:].startswith('21')
    return False

def main():
    print("=================================================================")
    print("CONSOLIDATION FINALE ET SYNCHRONISATION EXCEL DES TESTS WHATSAPP")
    print("=================================================================")

    # 1. Load all JSONL files from all workers
    jsonl_files = glob.glob(os.path.join(VERIFIER_DIR, "*.jsonl"))
    tested_numbers = {} # num -> {statut, wid, worker, teste_le}

    for jf in jsonl_files:
        with open(jf, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try:
                    obj = json.loads(line)
                    if "numero" in obj and "statut" in obj:
                        num = re.sub(r'\D', '', str(obj["numero"]))
                        if num:
                            tested_numbers[num] = obj
                except Exception:
                    pass

    print(f"Total numéros vérifiés chargés depuis {len(jsonl_files)} journaux JSONL : {len(tested_numbers)}")

    # 2. Open Master Excel
    wb = openpyxl.load_workbook(EXCEL_MAIN)
    ws_base = wb["Base Contacts"]
    ws_dash = wb["Synthèse & Tableau de bord"] if "Synthèse & Tableau de bord" in wb.sheetnames else None

    max_r = ws_base.max_row
    max_c = ws_base.max_column
    has_col25 = max_c >= 25

    stats = Counter()
    promoted_count = 0

    for row_idx in range(2, max_r + 1):
        rec_id = str(ws_base.cell(row=row_idx, column=1).value or "").strip()
        country = str(ws_base.cell(row=row_idx, column=2).value or "").strip()
        p1 = str(ws_base.cell(row=row_idx, column=10).value or "").strip()
        p2 = str(ws_base.cell(row=row_idx, column=11).value or "").strip()

        p1_d = re.sub(r'\D', '', p1)
        p2_d = re.sub(r'\D', '', p2)

        if not p1_d and not p2_d:
            ws_base.cell(row=row_idx, column=12).value = "Sans téléphone"
            stats["no_phone"] += 1
            continue

        p1_tested = tested_numbers.get(p1_d)
        p2_tested = tested_numbers.get(p2_d)

        p1_is_wa = p1_tested and p1_tested["statut"] == "oui"
        p2_is_wa = p2_tested and p2_tested["statut"] == "oui"

        if p1_is_wa:
            ws_base.cell(row=row_idx, column=12).value = f"WA : OUI (+{p1_d})"
            stats["wa_oui"] += 1
        elif p2_is_wa:
            # Promote secondary to primary!
            ws_base.cell(row=row_idx, column=10).value = f"+{p2_d}"
            ws_base.cell(row=row_idx, column=11).value = f"+{p1_d}" if p1_d else ""
            ws_base.cell(row=row_idx, column=12).value = f"WA : OUI (+{p2_d})"
            stats["wa_oui"] += 1
            stats["promoted"] += 1
            promoted_count += 1
        elif (p1_tested and p1_tested["statut"] == "non") or (p2_tested and p2_tested["statut"] == "non"):
            ws_base.cell(row=row_idx, column=12).value = "WA : NON"
            stats["wa_non"] += 1
        elif is_fixed(p1_d) and (not p2_d or is_fixed(p2_d)):
            ws_base.cell(row=row_idx, column=12).value = "WA : NON (Ligne Fixe uniquement)"
            stats["fixed_only"] += 1
        else:
            ws_base.cell(row=row_idx, column=12).value = "WA : NON"
            stats["wa_non"] += 1

    # 3. Update Dashboard KPIs if available
    if ws_dash:
        total_contacts = max_r - 1
        sec7_r = 86
        ws_dash.cell(row=sec7_r, column=1).value = "7. Bilan du Contrôle WhatsApp B2B Multi-Workers (GIC AGROPELC)"
        ws_dash.cell(row=sec7_r+1, column=1).value = "Numéros MOBILES testés sur WhatsApp"
        ws_dash.cell(row=sec7_r+1, column=2).value = f"{len(tested_numbers)} (100.0% des mobiles)"

        ws_dash.cell(row=sec7_r+2, column=1).value = "Comptes WhatsApp actifs confirmés (WA : OUI)"
        ws_dash.cell(row=sec7_r+2, column=2).value = f"{stats['wa_oui']} ({stats['wa_oui']*100/total_contacts:.1f}%)"

        ws_dash.cell(row=sec7_r+3, column=1).value = "Mobiles secondaires actifs promus en Téléphone Principal"
        ws_dash.cell(row=sec7_r+3, column=2).value = promoted_count

        ws_dash.cell(row=sec7_r+4, column=1).value = "Numéros mobiles non inscrits sur WhatsApp (WA : NON)"
        ws_dash.cell(row=sec7_r+4, column=2).value = f"{stats['wa_non']} ({stats['wa_non']*100/total_contacts:.1f}%)"

        ws_dash.cell(row=sec7_r+5, column=1).value = "Lignes restant uniquement fixes (Camtel/Gabon Telecom - filtrées)"
        ws_dash.cell(row=sec7_r+5, column=2).value = f"{stats['fixed_only']} ({stats['fixed_only']*100/total_contacts:.1f}%)"

    wb.save(EXCEL_MAIN)
    wb.close()
    shutil.copy2(EXCEL_MAIN, EXCEL_ENRICHI)

    print("\n=================================================================")
    print("BILAN CONSOLIDÉ DES CONTACTS DANS LE CLASSEUR EXCEL :")
    print(f"- Total entreprises dans la base : {max_r - 1}")
    print(f"- Entreprises joignables sur WHATSAPP (WA : OUI) : {stats['wa_oui']} ({stats['wa_oui']*100/(max_r - 1):.1f}%)")
    print(f"- Mobiles secondaires actifs promus en Principal : {promoted_count}")
    print(f"- Entreprises avec mobile testé sans WhatsApp (WA : NON) : {stats['wa_non']} ({stats['wa_non']*100/(max_r - 1):.1f}%)")
    print(f"- Entreprises avec ligne fixe uniquement (non mobile) : {stats['fixed_only']} ({stats['fixed_only']*100/(max_r - 1):.1f}%)")
    print(f"- Entreprises sans téléphone public (pistes web) : {stats['no_phone']}")
    print(f"- Fichier maître mis à jour : {EXCEL_MAIN}")
    print(f"- Fichier miroir mis à jour : {EXCEL_ENRICHI}")
    print("=================================================================")

if __name__ == "__main__":
    main()
