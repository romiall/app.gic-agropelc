import openpyxl
import re
import json
import urllib.request
import urllib.parse
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed

claude_path = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE_ENRICHI_CLAUDE.xlsx"

wb_c = openpyxl.load_workbook(claude_path, read_only=True, data_only=True)
c_rows = list(wb_c["Base Contacts"].iter_rows(values_only=True))[1:]
wb_c.close()

PORTAL_PHONES = {
    '237675335252', '237655658012', '237699000000', '237677000000',
    '237222222222', '237600000000'
}

PORTAL_EMAIL_DOMAINS = {
    'maligah.com', 'goafricaonline.com', 'chadyp.com', 'armp.cm',
    'example.com', 'domain.com', 'yoursite.com', 'email.com',
    'sentry.io', 'sentry.wixpress.com', 'wixpress.com', 'wordpress.org',
    'w3.org', 'schema.org', 'google.com', 'facebook.com', 'whatsapp.com',
    'petitfute.com', 'tripadvisor.com', 'booking.com'
}

BAD_EMAIL_EXTS = (
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.js', '.css',
    '.woff', '.woff2', '.ttf', '.eot', '.ico', '.pdf', '.mp4'
)

def is_valid_cm_mobile(d9):
    if len(d9) != 9 or not d9.startswith('6'):
        return False
    p2 = d9[:2]
    if p2 in ('62', '65', '66', '67', '68', '69'):
        # Check against sequential/dummy patterns
        if len(set(d9)) <= 2 or d9 in ('670000000', '690000000', '650000000'):
            return False
        return True
    return False

def extract_valid_mobiles(text, country):
    found = []
    c_low = str(country or '').lower()
    if 'cameroun' in c_low:
        # Match explicit +237 or tel: links or formatted 6XX XX XX XX
        patterns = [
            r'(?:\+237|00237|237)[\s\.\-\(\)]*(6\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2,3})',
            r'tel:[\+\s0]*237(6\d{8})',
            r'tel:[\+\s0]*(6[256789]\d{7})\b',
            r'(?:Tél|Tel|Phone|Mobile|WhatsApp|Contact|Cel|Cell|Appel)[^0-9\+]{0,25}(?:\+237|00237|237)?[\s\.\-\(\)]*(6[256789]\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})'
        ]
        for pat in patterns:
            for m in re.findall(pat, text, flags=re.IGNORECASE):
                d9 = re.sub(r'\D', '', m)
                if is_valid_cm_mobile(d9):
                    full = '237' + d9
                    if full not in PORTAL_PHONES and full not in found:
                        found.append(full)
    elif 'gabon' in c_low:
        patterns = [
            r'(?:\+241|00241|241)[\s\.\-\(\)]*(0?[67]\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})',
            r'tel:[\+\s0]*241(0?[67]\d{6,7})'
        ]
        for pat in patterns:
            for m in re.findall(pat, text, flags=re.IGNORECASE):
                d_sub = re.sub(r'\D', '', m)
                if len(d_sub) in (7, 8) and d_sub.lstrip('0').startswith(('6', '7')):
                    full = '241' + d_sub
                    if full not in PORTAL_PHONES and full not in found:
                        found.append(full)
    elif 'congo' in c_low:
        patterns = [
            r'(?:\+242|00242|242)[\s\.\-\(\)]*(0[456][\s\.\-]?\d{3}[\s\.\-]?\d{4}|0[456][\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{3})',
            r'tel:[\+\s0]*242(0[456]\d{7})'
        ]
        for pat in patterns:
            for m in re.findall(pat, text, flags=re.IGNORECASE):
                d_sub = re.sub(r'\D', '', m)
                if len(d_sub) == 9 and d_sub.startswith(('04', '05', '06')):
                    full = '242' + d_sub
                    if full not in found:
                        found.append(full)
    elif 'tchad' in c_low:
        patterns = [
            r'(?:\+235|00235|235)[\s\.\-\(\)]*([697]\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})',
            r'tel:[\+\s0]*235([697]\d{7})'
        ]
        for pat in patterns:
            for m in re.findall(pat, text, flags=re.IGNORECASE):
                d_sub = re.sub(r'\D', '', m)
                if len(d_sub) == 8 and d_sub[0] in ('6', '9', '7'):
                    full = '235' + d_sub
                    if full not in found:
                        found.append(full)
    elif 'centraf' in c_low:
        patterns = [
            r'(?:\+236|00236|236)[\s\.\-\(\)]*(7\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})',
            r'tel:[\+\s0]*236(7\d{7})'
        ]
        for pat in patterns:
            for m in re.findall(pat, text, flags=re.IGNORECASE):
                d_sub = re.sub(r'\D', '', m)
                if len(d_sub) == 8 and d_sub.startswith('7'):
                    full = '236' + d_sub
                    if full not in found:
                        found.append(full)
    elif 'guin' in c_low:
        patterns = [
            r'(?:\+240|00240|240)[\s\.\-\(\)]*((?:222|555|666)[\s\.\-]?\d{3}[\s\.\-]?\d{3})',
            r'tel:[\+\s0]*240((?:222|555|666)\d{6})'
        ]
        for pat in patterns:
            for m in re.findall(pat, text, flags=re.IGNORECASE):
                d_sub = re.sub(r'\D', '', m)
                if len(d_sub) == 9 and d_sub.startswith(('222', '555', '666')):
                    full = '240' + d_sub
                    if full not in found:
                        found.append(full)
    return found

def extract_valid_emails(text):
    found = []
    # Check mailto first
    for em in re.findall(r'mailto:([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)', text, flags=re.IGNORECASE):
        em_low = em.lower().strip('.').strip()
        domain = em_low.split('@')[-1]
        if not em_low.endswith(BAD_EMAIL_EXTS) and domain not in PORTAL_EMAIL_DOMAINS and '.' in domain and len(domain) >= 4:
            if em_low not in found:
                found.append(em_low)
    for em in re.findall(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+', text):
        em_low = em.lower().strip('.').strip()
        domain = em_low.split('@')[-1]
        if not em_low.endswith(BAD_EMAIL_EXTS) and domain not in PORTAL_EMAIL_DOMAINS and '.' in domain and len(domain) >= 4:
            if not any(bad in em_low for bad in ['example', 'sentry', 'wixpress', 'wordpress', 'yoursite', 'johndoe', 'uetr', 'bootstrap', 'jquery', 'fontawesome']):
                if em_low not in found:
                    found.append(em_low)
    return found

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Collect all rows with corporate websites (or non-portal URLs) that need either mobile or email
tasks = []
for idx, r in enumerate(c_rows, 2):
    u = str(r[15] or '').strip()
    if not u.startswith('http'):
        continue
    is_portal = any(d in u.lower() for d in [
        'maligah.com', 'goafricaonline.com', 'chadyp.com', 'facebook.com',
        'tripadvisor', 'booking.com', 'expedia', 'pagesjaunes', 'cybo.com',
        'vymaps', 'near-place', 'afrikta', 'petitfute', 'evendo', 'armp.cm',
        'minpmeesa.cm', 'fnecm.org', 'izf.net', 'wikipedia.org'
    ])
    if not is_portal:
        tasks.append((idx, r[1], r[4], str(r[9] or ''), str(r[12] or ''), u))

print(f"Corporate websites to scan: {len(tasks)}")

def scan_corporate_site(item):
    idx, country, name, p1, email, url = item
    mobiles = []
    emails = []
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        html = urllib.request.urlopen(req, timeout=7, context=ctx).read().decode('utf-8', errors='ignore')
        mobiles.extend(extract_valid_mobiles(html, country))
        emails.extend(extract_valid_emails(html))
        
        # If missing email or mobile, check if there is a contact link on the same domain
        if (not mobiles or not emails):
            contact_links = re.findall(r'href=["\']([^"\']*contact[^"\']*)["\']', html, flags=re.IGNORECASE)
            if contact_links:
                c_url = urllib.parse.urljoin(url, contact_links[0])
                if c_url != url and c_url.startswith('http'):
                    req2 = urllib.request.Request(c_url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
                    html2 = urllib.request.urlopen(req2, timeout=6, context=ctx).read().decode('utf-8', errors='ignore')
                    for m in extract_valid_mobiles(html2, country):
                        if m not in mobiles: mobiles.append(m)
                    for e in extract_valid_emails(html2):
                        if e not in emails: emails.append(e)
    except Exception:
        pass
    return {
        "row": idx,
        "country": country,
        "name": name,
        "url": url,
        "mobiles": mobiles[:4],
        "emails": emails[:3]
    }

enriched_sites = []
with ThreadPoolExecutor(max_workers=20) as ex:
    futs = [ex.submit(scan_corporate_site, t) for t in tasks]
    for f in as_completed(futs):
        res = f.result()
        if res["mobiles"] or res["emails"]:
            enriched_sites.append(res)

with open(r"c:\xampp\htdocs\app.gic-agropelc\scratch\corporate_websites_enriched.json", "w", encoding="utf-8") as f:
    json.dump(enriched_sites, f, ensure_ascii=False, indent=2)

print(f"Saved {len(enriched_sites)} enriched corporate website records to scratch/corporate_websites_enriched.json")
