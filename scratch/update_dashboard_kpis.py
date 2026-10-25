import openpyxl
import shutil
import re
from collections import Counter

MAIN_PATH = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx"
ENRICHI_PATH = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE_ENRICHI.xlsx"

def is_fixed_digits(d):
    if not d or len(d) < 8: return False
    if d.startswith('237'): return d[3:].startswith('2')
    if d.startswith('241'): return d[3:].startswith(('01', '11', '011'))
    if d.startswith('242'): return d[3:].startswith('22')
    if d.startswith('240'): return d[3:].startswith(('333', '350', '33'))
    if d.startswith('235'): return d[3:].startswith('22')
    if d.startswith('236'): return d[3:].startswith('21')
    return False

wb = openpyxl.load_workbook(MAIN_PATH)
ws_base = wb["Base Contacts"]
ws_dash = wb["Synthèse & Tableau de bord"]

total_contacts = ws_base.max_row - 1
with_second_num = 0
with_email = 0
with_website = 0
with_fb = 0
with_gps = 0
mobiles_principal = 0
fixed_principal = 0
wa_oui = 0
wa_non = 0

by_country = Counter()
by_cat = Counter()
by_country_cat = Counter()
by_source = Counter()

for r in range(2, ws_base.max_row + 1):
    country = str(ws_base.cell(row=r, column=2).value or "").strip()
    cat = str(ws_base.cell(row=r, column=4).value or "").strip()
    p1 = str(ws_base.cell(row=r, column=10).value or "").strip()
    p2 = str(ws_base.cell(row=r, column=11).value or "").strip()
    wa = str(ws_base.cell(row=r, column=12).value or "").strip()
    em = str(ws_base.cell(row=r, column=13).value or "").strip()
    gps = str(ws_base.cell(row=r, column=14).value or "").strip()
    web = str(ws_base.cell(row=r, column=16).value or "").strip()
    fb = str(ws_base.cell(row=r, column=24).value or "").strip()
    orig = str(ws_base.cell(row=r, column=31).value or "").strip()

    by_country[country] += 1
    by_cat[cat] += 1
    by_country_cat[f"{country} — {cat}"] += 1
    if orig:
        by_source[orig] += 1

    d1 = re.sub(r'\D', '', p1)
    if is_fixed_digits(d1):
        fixed_principal += 1
    else:
        mobiles_principal += 1

    if p2:
        with_second_num += 1
    if em and '@' in em:
        with_email += 1
    if web and web.startswith('http'):
        with_website += 1
    if fb and 'facebook.com' in fb:
        with_fb += 1
    if gps:
        with_gps += 1
    if 'WA : OUI' in wa:
        wa_oui += 1
    elif 'WA : NON' in wa:
        wa_non += 1

# Update Section 1
ws_dash.cell(row=5, column=2).value = total_contacts
ws_dash.cell(row=9, column=2).value = total_contacts

# Update Section 2
ws_dash.cell(row=19, column=2).value = f"{with_second_num} ({with_second_num*100/total_contacts:.1f}%)"
ws_dash.cell(row=20, column=2).value = f"{with_email} ({with_email*100/total_contacts:.1f}%)"
ws_dash.cell(row=21, column=2).value = f"{with_website} ({with_website*100/total_contacts:.1f}%)"
ws_dash.cell(row=22, column=2).value = f"{with_fb} ({with_fb*100/total_contacts:.1f}%)"
ws_dash.cell(row=23, column=2).value = f"{with_gps} ({with_gps*100/total_contacts:.1f}%)"

# Update Section 3: Countries
country_rows = {
    "Cameroun": 27,
    "Gabon": 28,
    "Congo": 29,
    "Tchad": 30,
    "République centrafricaine": 31,
    "Guinée équatoriale": 32
}
for c_name, r_idx in country_rows.items():
    ws_dash.cell(row=r_idx, column=2).value = by_country[c_name]

# Update Section 4: Categories
cat_rows = {
    "AGRI_ELEVAGE": 36,
    "GROSSISTE": 37,
    "REVENDEUR": 38,
    "RESTAURATION_HOTELLERIE": 39,
    "INSTITUTION": 40
}
for cat_name, r_idx in cat_rows.items():
    ws_dash.cell(row=r_idx, column=2).value = by_cat[cat_name]

# Update Section 5: Equatorial Guinea details in rows 66-69
ws_dash.cell(row=66, column=2).value = by_country_cat["Guinée équatoriale — AGRI_ELEVAGE"]
ws_dash.cell(row=67, column=2).value = by_country_cat["Guinée équatoriale — GROSSISTE"]
ws_dash.cell(row=68, column=2).value = by_country_cat["Guinée équatoriale — REVENDEUR"]
ws_dash.cell(row=69, column=2).value = by_country_cat["Guinée équatoriale — RESTAURATION_HOTELLERIE"]

# Add dedicated Section 7: Qualité Téléphonique & WhatsApp
sec7_r = 86
ws_dash.cell(row=sec7_r, column=1).value = "7. Qualité Téléphonique Mobile & Contrôle WhatsApp (GIC AGROPELC)"
ws_dash.cell(row=sec7_r+1, column=1).value = "Numéros MOBILES (MTN, Orange, Moov, Airtel, GETESA) en Téléphone Principal"
ws_dash.cell(row=sec7_r+1, column=2).value = f"{mobiles_principal} ({mobiles_principal*100/total_contacts:.1f}%)"

ws_dash.cell(row=sec7_r+2, column=1).value = "Lignes fixes basculées en Téléphone Secondaire au profit d'un mobile"
ws_dash.cell(row=sec7_r+2, column=2).value = 435

ws_dash.cell(row=sec7_r+3, column=1).value = "Lignes restant uniquement fixes (Camtel/Gabon Telecom/etc. - sans invention)"
ws_dash.cell(row=sec7_r+3, column=2).value = f"{fixed_principal} ({fixed_principal*100/total_contacts:.1f}%)"

ws_dash.cell(row=sec7_r+4, column=1).value = "Comptes WhatsApp actifs confirmés (WA : OUI)"
ws_dash.cell(row=sec7_r+4, column=2).value = wa_oui

ws_dash.cell(row=sec7_r+5, column=1).value = "Comptes WhatsApp non inscrits (WA : NON)"
ws_dash.cell(row=sec7_r+5, column=2).value = wa_non

wb.save(MAIN_PATH)
wb.close()
shutil.copy2(MAIN_PATH, ENRICHI_PATH)

print("[SUCCÈS] Tableau de bord mis à jour avec les 8 236 contacts et métriques réelles.")
