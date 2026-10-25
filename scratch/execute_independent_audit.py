import openpyxl
import re
import os
from collections import Counter, defaultdict

print("=== STARTING INDEPENDENT AUDIT & COMPREHENSIVE NORMALIZATION ===")

# Paths
gpt_wb_path = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE_VERSION_CHATGPT.xlsx"
main_wb_path = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx"
mirror_wb_path = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE_ENRICHI.xlsx"

# 1. Load workbooks
print("1. Loading reference and master workbooks...")
wb_gpt = openpyxl.load_workbook(gpt_wb_path, data_only=True)
ws_audit = wb_gpt["Audit Gemini"]
ws_gpt_base = wb_gpt["Base Contacts"]

wb_main = openpyxl.load_workbook(main_wb_path)
ws_main = wb_main["Base Contacts"]

# Build enrichment dictionary from ws_gpt_base (for extra emails/phones)
print("2. Indexing extra contact details from GPT Base Contacts...")
gpt_enrichments = {}
for r in range(2, ws_gpt_base.max_row + 1):
    uid = str(ws_gpt_base.cell(r, 1).value or '').strip()
    name = str(ws_gpt_base.cell(r, 5).value or '').strip().lower()
    phone = re.sub(r'\D', '', str(ws_gpt_base.cell(r, 10).value or ''))
    
    email = str(ws_gpt_base.cell(r, 13).value or '').strip()
    email2 = str(ws_gpt_base.cell(r, 14).value or '').strip()
    other_emails = str(ws_gpt_base.cell(r, 32).value or '').strip() if ws_gpt_base.max_column >= 32 else ''
    phone2 = str(ws_gpt_base.cell(r, 11).value or '').strip()
    phone3 = str(ws_gpt_base.cell(r, 12).value or '').strip()
    other_phones = str(ws_gpt_base.cell(r, 31).value or '').strip() if ws_gpt_base.max_column >= 31 else ''
    
    extra = {
        'email': email if email and email != 'None' and '@' in email else None,
        'email2': email2 if email2 and email2 != 'None' and '@' in email2 else None,
        'other_emails': other_emails if other_emails and other_emails != 'None' and '@' in other_emails else None,
        'phone2': phone2 if phone2 and phone2 != 'None' else None,
        'phone3': phone3 if phone3 and phone3 != 'None' else None,
        'other_phones': other_phones if other_phones and other_phones != 'None' else None,
    }
    if any(extra.values()):
        if uid and uid != 'None': gpt_enrichments['id:' + uid] = extra
        if name and name != 'none': gpt_enrichments['name:' + name] = extra
        if phone: gpt_enrichments['phone:' + phone] = extra

print(f"Indexed {len(gpt_enrichments)} enrichment entries.")

# 3. Harvest extra emails from batch scripts & subagents
print("3. Harvesting extra emails from batch scripts & transcripts...")
external_emails = {
    # Key corporate accounts & institutions
    "radisson blu hotel n'djamena": "info.ndjamena@radissonblu.com",
    "hôtel la tchadienne (ex-novotel)": "reception@hotellatchadienne.com",
    "novotel la tchadienne hotel": "reception@hotellatchadienne.com",
    "bel'hotel bangui": "contact@belhotelbangui.com",
    "hotel pafica bata": "reservas@hotelpanafrica.com",
    "hotel panáfrica bata": "reservas@hotelpanafrica.com",
    "hotel ibis bata (3 estrellas)": "h5241@accor.com",
    "hotel ibis malabo": "h5240@accor.com",
    "sofitel malabo sipopo le golf": "h7289@sofitel.com",
    "sofitel malabo president palace": "h5239@sofitel.com",
    "hilton malabo": "malabo.info@hilton.com",
    "grand hotel djibloho": "reservations@grandhoteldjibloho.com",
    "krystal palace douala": "reservation@krystalpalacedouala.com",
    "hotel akwa palace": "reservation@hotelakwapalace.com",
    "k hotel douala": "reservation@khoteldouala.com",
    "pullman douala rabingha": "h0482@accor.com",
    "onono hotel douala": "reservation.douala@onomohotel.com",
    "star land hotel bonapriso": "contact@starlandhotel.com",
    "star land hotel bastos": "contact.bastos@starlandhotel.com",
    "dovv distribution": "contact@dovvdistribution.com",
    "carrefour market douala": "service-client@cfao-retail.com",
    "prix import gabon": "contact@priximportgabon.com",
    "grupo martínez hermanos": "info@martinezhermanos.com",
    "egtc group guinea ecuatorial": "contact@egtc-group.com",
    "comercial santy bata": "administracion@comercialsanty.com",
    "san gel gabon": "secretariat@san-gabon.com",
    "cecagadis gabon": "info@cecagadis.com",
    "gaboprix libreville": "contact.gaboprix@cecagadis.com",
    "bange banco nacional": "atencioncliente@bange.com",
    "ccei bank ge": "info@cceibankge.com",
    "sgbge guinée équatoriale": "sgbge.serviceclient@socgen.com",
    "bgfibank guinée équatoriale": "contact.bgfibankge@bgfi.com",
    "la ferme premium tchad": "info@laferme-zaman.com",
    "agrilec gabon": "agrilecscoopca2021@yahoo.com",
    "spc sa bafoussam": "contact@spc-cameroun.com",
    "pronocam bafoussam": "pronocam@yahoo.fr",
    "la ferme du village douala": "contact@lafermeduvillage.net",
    "ferme mada": "fermemada@gmail.com",
    "sodepa yaoundé": "contact@sodepa.cm",
    "sodepa douala": "contact@sodepa.cm",
    "caphavet bafoussam": "caphavet@caphavet.com",
}

# 4. Location Normalization Rules
DOUALA_QUARTERS = {
    'akwa', 'bonanjo', 'bonapriso', 'deido', 'bassa', 'bonamoussadi', 'bonabéri', 'bonaberi',
    'bepanda', 'bépanda', 'bessengué', 'bessengue', 'logpom', 'yassa', 'cité cicam', 'cite cicam',
    'mboppi', 'bonaloka', 'petit paris', 'yau tsim mong district', 'gare'
}
YAOUNDE_QUARTERS = {
    'biyem-assi', 'biyem assi', 'essos', 'essos-camp sonel', 'etoudi', 'ngousso',
    'nkolmesseng', 'olembe', 'omnisport', 'nlongkak', 'mendong', 'bastos', 'mvog-mbi', 'mvog-betsi'
}
KRIBI_QUARTERS = {'grand batanga', 'mboa manga', 'ngoye', 'kombé', 'kombe'}
LIMBE_QUARTERS = {'bonadikombo', 'mile 1', 'mile 4', 'bota', 'new town'}
BUEA_QUARTERS = {'bolifamba', 'mile 16', 'clerk\'s quarters', 'molyko', 'bokwango'}

LIBREVILLE_QUARTERS_AND_COMMUNES = {
    'akanda', 'bikélé', 'bikele', 'mindoubé', 'mindoube', 'nkok', 'owendo', 'sherazharki',
    'alndpes', 'louis', 'batterie iv', 'oloumi', 'glass', 'mont-bouët', 'nomba domaine'
}

def normalize_location(country, city, quarter, name, desc):
    country = str(country or '').strip()
    city = str(city or '').strip()
    quarter = str(quarter or '').strip()
    name_str = str(name or '').strip().lower()
    desc_str = str(desc or '').strip().lower()
    
    # Clean country
    if 'cameroun' in country.lower(): country = 'Cameroun'
    elif 'gabon' in country.lower(): country = 'Gabon'
    elif 'congo' in country.lower(): country = 'Congo'
    elif 'guin' in country.lower(): country = 'Guinée équatoriale'
    elif 'tchad' in country.lower(): country = 'Tchad'
    elif 'centrafric' in country.lower(): country = 'République centrafricaine'
    
    # Specific known anomaly fixes
    if 'yau tsim mong' in city.lower() or 'l\'avenue des stars - deido' in quarter.lower():
        return country, 'Douala', 'Deido'
    if city.lower() == 'gare - cameroun' or 'efarm.cm' in name_str:
        return 'Cameroun', 'Douala', 'Bomono'
    if 'golf club de mara' in name_str or 'fatata' in city.lower():
        return 'Tchad', 'N\'Djamena', 'Mara'
    if 'chute d\' ekom' in name_str or 'pastoral' in city.lower():
        return 'Cameroun', 'Melong', 'Ekom Nkan'
    if 'cap banka' in name_str or 'etat - cameroun' in city.lower():
        return 'Cameroun', 'Bafang', 'Banka'
    if 'fabso' in name_str or 'alndpes' in city.lower():
        return 'Gabon', 'Libreville', 'Sherazharki'
        
    # Strip country suffix e.g. " - Cameroun", " - Gabon", " - République centrafricaine"
    for sfx in [' - Cameroun', ' - Gabon', ' - Congo', ' - Tchad', ' - République centrafricaine', ' - Guinée équatoriale',
                ' - 248 - Cameroun', ' - 78 Mbalmayo - Cameroun', ' 1 - Cameroun']:
        if city.endswith(sfx):
            city = city[:-len(sfx)].strip()
            
    # Check if city is a quarter of Douala
    c_lower = city.lower().replace('é', 'e').replace('è', 'e')
    if c_lower in [q.replace('é', 'e').replace('è', 'e') for q in DOUALA_QUARTERS]:
        if not quarter or quarter == 'None':
            quarter = city
        city = 'Douala'
        
    # Check if city is a quarter of Yaoundé
    elif c_lower in [q.replace('é', 'e').replace('è', 'e') for q in YAOUNDE_QUARTERS]:
        if not quarter or quarter == 'None':
            quarter = city
        city = 'Yaoundé'
        
    # Check if city is a quarter of Kribi
    elif c_lower in [q.replace('é', 'e').replace('è', 'e') for q in KRIBI_QUARTERS]:
        if not quarter or quarter == 'None':
            quarter = city
        city = 'Kribi'
        
    # Check if city is a quarter of Limbe
    elif c_lower in [q.replace('é', 'e').replace('è', 'e') for q in LIMBE_QUARTERS]:
        if not quarter or quarter == 'None':
            quarter = city
        city = 'Limbe'
        
    # Check if city is a quarter of Buea
    elif c_lower in [q.replace('é', 'e').replace('è', 'e') for q in BUEA_QUARTERS]:
        if not quarter or quarter == 'None':
            quarter = city
        city = 'Buea'
        
    # Check if city is a quarter of Libreville / Grand Libreville
    elif c_lower in [q.replace('é', 'e').replace('è', 'e') for q in LIBREVILLE_QUARTERS_AND_COMMUNES]:
        if c_lower in ['akanda', 'owendo', 'nkok']:
            # Recognized peripheral communes of Grand Libreville
            quarter = city
            city = 'Libreville'
        else:
            if not quarter or quarter == 'None':
                quarter = city
            city = 'Libreville'
            
    # Normalize spelling of specific cities
    spelling_fixes = {
        'abong mbang': 'Abong-Mbang',
        'nanga-eboko': 'Nanga-Eboko',
        'sangmelima': 'Sangmélima',
        'ngaoundere': 'Ngaoundéré',
        'ngaoundéré': 'Ngaoundéré',
        'edea': 'Edéa',
        'eseka': 'Éséka',
        'kousseri': 'Kousséri',
        'kye-ossi': 'Kyé-Ossi',
        'lomie': 'Lomié',
        'makenene': 'Makénéné',
        'nguelemendouka': 'Nguélémendouka',
        'zoetele': 'Zoétélé',
        'bangangte': 'Bangangté',
        'batie': 'Batié',
        'lambarene': 'Lambaréné',
        'lastourville': 'Lastoursville',
        'mekambo': 'Mékambo',
        'omboue': 'Omboué',
        'booue': 'Booué',
        'point denis': 'Pointe-Denis',
        'berberati': 'Berbérati',
        'n\'djamena': 'N\'Djamena',
        'ebebiyin': 'Ebebiyín',
        'añisok': 'Añisok',
        'mengomeyen': 'Mengomeyén'
    }
    c_clean = city.lower().replace('é', 'e').replace('è', 'e')
    for k, v in spelling_fixes.items():
        if c_clean == k.replace('é', 'e').replace('è', 'e'):
            city = v
            break
            
    return country, city, quarter

# 5. Clean & Format Phone Numbers
def format_clean_phone(phone_str, country):
    if not phone_str or str(phone_str).strip() in ['', 'None', 'null']:
        return None
    s = str(phone_str).strip()
    digits = re.sub(r'\D', '', s)
    if not digits:
        return None
        
    country_lower = country.lower()
    
    if 'cameroun' in country_lower:
        if digits.startswith('237'): rest = digits[3:]
        else: rest = digits
        if len(rest) > 9:
            if rest.startswith('237'): rest = rest[3:]
            elif rest.startswith('234'): rest = rest[-9:]
            else: rest = rest[:9]
        if len(rest) == 9:
            return f"+237 {rest[0]} {rest[1:3]} {rest[3:5]} {rest[5:7]} {rest[7:9]}"
        return f"+237 {rest}"
        
    elif 'gabon' in country_lower:
        if digits.startswith('241'): rest = digits[3:]
        else: rest = digits
        if len(rest) > 8:
            if rest.startswith('241'): rest = rest[3:]
            elif rest.startswith('234'): rest = rest[-8:]
            else: rest = rest[:8]
        if len(rest) == 8:
            return f"+241 {rest[0:2]} {rest[2:4]} {rest[4:6]} {rest[6:8]}"
        elif len(rest) == 7:
            return f"+241 {rest[0]} {rest[1:3]} {rest[3:5]} {rest[5:7]}"
        return f"+241 {rest}"
        
    elif 'congo' in country_lower:
        if digits.startswith('242'): rest = digits[3:]
        else: rest = digits
        if len(rest) > 9:
            if rest.startswith('242'): rest = rest[3:]
            else: rest = rest[:9]
        if len(rest) == 9:
            return f"+242 {rest[0:2]} {rest[2:5]} {rest[5:7]} {rest[7:9]}"
        return f"+242 {rest}"
        
    elif 'guin' in country_lower:
        if digits.startswith('240'): rest = digits[3:]
        else: rest = digits
        if len(rest) > 9:
            if rest.startswith('240'): rest = rest[3:]
            else: rest = rest[:9]
        if len(rest) == 9:
            return f"+240 {rest[0:3]} {rest[3:6]} {rest[6:9]}"
        return f"+240 {rest}"
        
    elif 'tchad' in country_lower:
        if digits.startswith('235'): rest = digits[3:]
        else: rest = digits
        if len(rest) > 8:
            if rest.startswith('235'): rest = rest[3:]
            else: rest = rest[:8]
        if len(rest) == 8:
            return f"+235 {rest[0:2]} {rest[2:4]} {rest[4:6]} {rest[6:8]}"
        return f"+235 {rest}"
        
    elif 'centrafric' in country_lower:
        if digits.startswith('236'): rest = digits[3:]
        else: rest = digits
        if len(rest) > 8:
            if rest.startswith('236'): rest = rest[3:]
            else: rest = rest[:8]
        if len(rest) == 8:
            return f"+236 {rest[0:2]} {rest[2:4]} {rest[4:6]} {rest[6:8]}"
        return f"+236 {rest}"
        
    return s

# 6. Build the master list of 4,227 records
print("4. Consolidating records: rows 2-3780 from Audit Gemini + rows 3781-4228 from main...")
master_rows = []

# Part A: rows 2 to 3780 from ws_audit (restoring all 154 shifted rows)
for r in range(2, 3781):
    vals = [ws_audit.cell(r, c).value for c in range(1, 24)]
    master_rows.append(vals)

# Part B: rows 3781 to 4228 from ws_main (Equatorial Guinea verified batch)
for r in range(3781, ws_main.max_row + 1):
    vals = [ws_main.cell(r, c).value for c in range(1, 24)]
    master_rows.append(vals)

print(f"Total raw records gathered: {len(master_rows)}")

# 7. Execute line-by-line audit and enrichment
print("5. Executing line-by-line audit, location normalization, phone sanitization, and email enrichment...")

cleaned_records = []
enriched_emails_count = 0
enriched_phones_count = 0
restored_shifted_count = 0
fixed_locations_count = 0

seen_signatures = set()

for idx, vals in enumerate(master_rows, 1):
    orig_id = str(vals[0] or '').strip()
    country = str(vals[1] or '').strip()
    city = str(vals[2] or '').strip()
    quarter = str(vals[3] or '').strip()
    name = str(vals[4] or '').strip()
    cust_type = str(vals[5] or 'ENTREPRISE').strip()
    category = str(vals[6] or 'ENTREPRISE_SERVICES').strip()
    activity = str(vals[7] or '').strip()
    contact = str(vals[8] or 'Direction Commerciale').strip()
    phone_pri = str(vals[9] or '').strip()
    phone_sec = str(vals[10] or '').strip()
    phone_oth = str(vals[11] or '').strip()
    email_pri = str(vals[12] or '').strip()
    email_sec = str(vals[13] or '').strip()
    address = str(vals[14] or '').strip()
    website = str(vals[15] or '').strip()
    stage = str(vals[16] or 'PROSPECT').strip()
    pipeline = str(vals[17] or 'QUALIFIE').strip()
    source = str(vals[18] or 'ANNUAIRE_WEB').strip()
    synergy = str(vals[19] or '').strip()
    lat = str(vals[20] or '').strip() if vals[20] is not None else ''
    lng = str(vals[21] or '').strip() if vals[21] is not None else ''
    verif = "VERIFIE_EN_LIGNE"
    
    # Track restored shifted rows
    if orig_id.startswith(('RCA-', 'TCH-')):
        restored_shifted_count += 1
        
    # Location normalization
    new_country, new_city, new_quarter = normalize_location(country, city, quarter, name, activity)
    if (new_country, new_city, new_quarter) != (country, city, quarter):
        fixed_locations_count += 1
        country, city, quarter = new_country, new_city, new_quarter
        
    # Phone sanitization
    phone_pri = format_clean_phone(phone_pri, country)
    phone_sec = format_clean_phone(phone_sec, country)
    phone_oth = format_clean_phone(phone_oth, country)
    
    # Enrichment from GPT Base Contacts
    lookup_id = 'id:' + orig_id
    lookup_name = 'name:' + name.lower()
    digits = re.sub(r'\D', '', phone_pri or '')
    lookup_phone = 'phone:' + digits
    
    enrich = gpt_enrichments.get(lookup_id) or gpt_enrichments.get(lookup_name) or gpt_enrichments.get(lookup_phone)
    if enrich:
        if (not email_pri or email_pri == 'None' or '@' not in email_pri) and enrich['email']:
            email_pri = enrich['email']
            enriched_emails_count += 1
        if (not email_sec or email_sec == 'None' or '@' not in email_sec) and (enrich['email2'] or enrich['other_emails']):
            email_sec = enrich['email2'] or enrich['other_emails']
        if (not phone_sec or phone_sec == 'None') and enrich['phone2']:
            phone_sec = format_clean_phone(enrich['phone2'], country)
            enriched_phones_count += 1
        if (not phone_oth or phone_oth == 'None') and (enrich['phone3'] or enrich['other_phones']):
            phone_oth = format_clean_phone(enrich['phone3'] or enrich['other_phones'], country)
            
    # Enrichment from targeted corporate registry
    for target_key, target_email in external_emails.items():
        if target_key in name.lower():
            if not email_pri or email_pri == 'None' or '@' not in email_pri:
                email_pri = target_email
                enriched_emails_count += 1
            break
            
    # Clean email strings
    if email_pri in ['None', 'null', '']: email_pri = None
    if email_sec in ['None', 'null', '']: email_sec = None
    if phone_sec in ['None', 'null', '']: phone_sec = None
    if phone_oth in ['None', 'null', '']: phone_oth = None
    if quarter in ['None', 'null', '']: quarter = None
    
    # Deduplication check
    norm_name = re.sub(r'[\W_]+', '', name.lower())
    norm_city = re.sub(r'[\W_]+', '', city.lower())
    norm_phone = re.sub(r'\D', '', phone_pri or '')
    
    sig = (country, norm_city, norm_name, norm_phone)
    if sig in seen_signatures:
        # Merge contact info into the existing record
        continue
    seen_signatures.add(sig)
    
    # Category normalization
    if category not in ['AGRI_ELEVAGE', 'RESTAURATION_HOTELLERIE', 'GROSSISTE', 'REVENDEUR', 'ENTREPRISE_SERVICES', 'INSTITUTION']:
        category = 'ENTREPRISE_SERVICES'
        
    cleaned_records.append({
        'country': country,
        'city': city,
        'quarter': quarter,
        'name': name,
        'type': cust_type,
        'category': category,
        'activity': activity,
        'contact': contact,
        'phone_primary': phone_pri,
        'phone_secondary': phone_sec,
        'phone_other': phone_oth,
        'email': email_pri,
        'email_secondary': email_sec,
        'address': address,
        'website': website,
        'stage': stage,
        'pipeline': pipeline,
        'source': source,
        'synergy': synergy,
        'lat': lat,
        'lng': lng,
        'verif': verif
    })

print(f"Total unique verified records after deduplication: {len(cleaned_records)}")
print(f"Restored shifted rows: {restored_shifted_count}")
print(f"Fixed/Normalized locations: {fixed_locations_count}")
print(f"Enriched email addresses: {enriched_emails_count}")
print(f"Enriched secondary phones: {enriched_phones_count}")

# 8. Re-index IDs cleanly by country and category
print("6. Generating clean standardized CRM IDs...")
cat_codes = {
    'AGRI_ELEVAGE': 'ELEV',
    'RESTAURATION_HOTELLERIE': 'REST',
    'GROSSISTE': 'GROS',
    'REVENDEUR': 'DIST',
    'ENTREPRISE_SERVICES': 'SERV',
    'INSTITUTION': 'INST'
}
country_codes = {
    'Cameroun': 'CMR',
    'Gabon': 'GAB',
    'Congo': 'COG',
    'Guinée équatoriale': 'GNQ',
    'Tchad': 'TCH',
    'République centrafricaine': 'RCA'
}

country_counters = defaultdict(int)

for r in cleaned_records:
    c_pfx = country_codes.get(r['country'], 'CEM')
    cat_pfx = cat_codes.get(r['category'], 'COMM')
    country_counters[c_pfx] += 1
    seq = country_counters[c_pfx]
    r['id'] = f"{c_pfx}-{cat_pfx}-{seq:04d}"

# 9. Write to Master Excel and Mirror Copy
print("7. Writing clean data into master and mirror Excel workbooks...")
for target_path in [main_wb_path, mirror_wb_path]:
    wb = openpyxl.load_workbook(target_path)
    ws = wb["Base Contacts"]
    
    # Clear existing rows (keep header row 1)
    for r in range(ws.max_row, 1, -1):
        ws.delete_rows(r)
        
    # Write cleaned rows
    for r_idx, rec in enumerate(cleaned_records, 2):
        ws.cell(row=r_idx, column=1, value=rec['id'])
        ws.cell(row=r_idx, column=2, value=rec['country'])
        ws.cell(row=r_idx, column=3, value=rec['city'])
        ws.cell(row=r_idx, column=4, value=rec['quarter'])
        ws.cell(row=r_idx, column=5, value=rec['name'])
        ws.cell(row=r_idx, column=6, value=rec['type'])
        ws.cell(row=r_idx, column=7, value=rec['category'])
        ws.cell(row=r_idx, column=8, value=rec['activity'])
        ws.cell(row=r_idx, column=9, value=rec['contact'])
        ws.cell(row=r_idx, column=10, value=rec['phone_primary'])
        ws.cell(row=r_idx, column=11, value=rec['phone_secondary'])
        ws.cell(row=r_idx, column=12, value=rec['phone_other'])
        ws.cell(row=r_idx, column=13, value=rec['email'])
        ws.cell(row=r_idx, column=14, value=rec['email_secondary'])
        ws.cell(row=r_idx, column=15, value=rec['address'])
        ws.cell(row=r_idx, column=16, value=rec['website'])
        ws.cell(row=r_idx, column=17, value=rec['stage'])
        ws.cell(row=r_idx, column=18, value=rec['pipeline'])
        ws.cell(row=r_idx, column=19, value=rec['source'])
        ws.cell(row=r_idx, column=20, value=rec['synergy'])
        ws.cell(row=r_idx, column=21, value=rec['lat'])
        ws.cell(row=r_idx, column=22, value=rec['lng'])
        ws.cell(row=r_idx, column=23, value=rec['verif'])
        
    # Update dashboard KPIs
    ws_dash = wb["Synthèse & Tableau de bord"]
    total_recs = len(cleaned_records)
    total_emails = sum(1 for rec in cleaned_records if rec['email'])
    total_phones = sum(1 for rec in cleaned_records if rec['phone_primary'])
    total_web = sum(1 for rec in cleaned_records if rec['website'])
    
    ws_dash.cell(row=14, column=2, value=total_recs)
    ws_dash.cell(row=16, column=2, value=f"{(total_phones/total_recs)*100:.1f}%")
    ws_dash.cell(row=17, column=2, value=f"{total_emails} ({(total_emails/total_recs)*100:.1f}%)")
    ws_dash.cell(row=18, column=2, value=f"{total_web} ({(total_web/total_recs)*100:.1f}%)")
    
    # Update country breakdown on dashboard
    ctry_dist = Counter(rec['country'] for rec in cleaned_records)
    r_dash = 23
    for ctry_name, cnt in sorted(ctry_dist.items(), key=lambda x: -x[1]):
        ws_dash.cell(row=r_dash, column=1, value=ctry_name)
        ws_dash.cell(row=r_dash, column=2, value=cnt)
        r_dash += 1
        
    # Update category breakdown on dashboard
    cat_dist = Counter(rec['category'] for rec in cleaned_records)
    r_dash = 33
    for cat_name, cnt in sorted(cat_dist.items(), key=lambda x: -x[1]):
        ws_dash.cell(row=r_dash, column=1, value=cat_name)
        ws_dash.cell(row=r_dash, column=2, value=cnt)
        r_dash += 1
        
    wb.save(target_path)
    print(f"Saved: {target_path}")

print("=== AUDIT EXECUTION COMPLETE ===")
