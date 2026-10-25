import json
import re
import urllib.request
import urllib.parse
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed

with open(r"c:\xampp\htdocs\app.gic-agropelc\scratch\still_fixed_to_enrich.json", "r", encoding="utf-8") as f:
    fixed_rows = json.load(f)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

PORTAL_PHONES = {
    '237675335252', '237655658012', '237699000000', '237677000000',
    '237222222222', '237600000000'
}

PORTAL_DOMAINS = (
    'maligah.com', 'goafricaonline.com', 'chadyp.com', 'armp.cm',
    'example.com', 'domain.com', 'yoursite.com', 'email.com',
    'sentry.io', 'wixpress.com', 'wordpress.org', 'w3.org', 'schema.org',
    'google.com', 'facebook.com', 'twitter.com', 'instagram.com',
    'linkedin.com', 'youtube.com', 'whatsapp.com', 'cloudflare.com',
    'addtoany.com', 'sharethis.com', 'doubleclick.net', 'googlesyndication.com',
    'googletagmanager.com', 'gstatic.com', 'googleapis.com', 'yext.com',
    'empresasguinea.com', 'guinealia.com', 'salireneg.com'
)

BAD_EMAIL_EXTS = (
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.js', '.css',
    '.woff', '.woff2', '.ttf', '.eot', '.ico', '.pdf', '.mp4'
)

def is_valid_cm_mobile(d9):
    if len(d9) != 9 or not d9.startswith('6'):
        return False
    if d9[:2] in ('62', '65', '66', '67', '68', '69'):
        if len(set(d9)) <= 2:
            return False
        return True
    return False

def extract_mobiles(text, country):
    found = []
    c_low = str(country or '').lower()
    if 'cameroun' in c_low:
        for m in re.findall(r'(?:\+237|00237|237)?[\s\.\-\(\)]*(6[256789]\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})\b', text):
            d9 = re.sub(r'\D', '', m)
            if is_valid_cm_mobile(d9):
                full = '237' + d9
                if full not in PORTAL_PHONES and full not in found:
                    found.append(full)
    elif 'gabon' in c_low:
        for m in re.findall(r'(?:\+241|00241|241)[\s\.\-\(\)]*(0?[67]\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})\b', text):
            d_sub = re.sub(r'\D', '', m)
            if len(d_sub) in (7, 8) and d_sub.lstrip('0').startswith(('6', '7')):
                full = '241' + d_sub
                if full not in PORTAL_PHONES and full not in found:
                    found.append(full)
    elif 'tchad' in c_low:
        for m in re.findall(r'(?:\+235|00235|235)[\s\.\-\(\)]*([697]\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})\b', text):
            d_sub = re.sub(r'\D', '', m)
            if len(d_sub) == 8 and d_sub[0] in ('6', '9', '7'):
                full = '235' + d_sub
                if full not in found:
                    found.append(full)
    elif 'guin' in c_low:
        for m in re.findall(r'(?:\+240|00240|240)[\s\.\-\(\)]*((?:222|555|666)[\s\.\-]?\d{3}[\s\.\-]?\d{3})\b', text):
            d_sub = re.sub(r'\D', '', m)
            if len(d_sub) == 9 and d_sub.startswith(('222', '555', '666')):
                full = '240' + d_sub
                if full not in found:
                    found.append(full)
    elif 'centraf' in c_low:
        for m in re.findall(r'(?:\+236|00236|236)[\s\.\-\(\)]*(7\d[\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{2})\b', text):
            d_sub = re.sub(r'\D', '', m)
            if len(d_sub) == 8 and d_sub.startswith('7'):
                full = '236' + d_sub
                if full not in found:
                    found.append(full)
    elif 'congo' in c_low:
        for m in re.findall(r'(?:\+242|00242|242)[\s\.\-\(\)]*(0[456][\s\.\-]?\d{3}[\s\.\-]?\d{4}|0[456][\s\.\-]?\d{2}[\s\.\-]?\d{2}[\s\.\-]?\d{3})\b', text):
            d_sub = re.sub(r'\D', '', m)
            if len(d_sub) == 9 and d_sub.startswith(('04', '05', '06')):
                full = '242' + d_sub
                if full not in found:
                    found.append(full)
    return found

def extract_emails(text):
    found = []
    for em in re.findall(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+', text):
        em_low = em.lower().strip('.').strip()
        domain = em_low.split('@')[-1]
        if not em_low.endswith(BAD_EMAIL_EXTS) and not any(d in domain for d in PORTAL_DOMAINS) and '.' in domain and len(domain) >= 4:
            if not any(bad in em_low for bad in ['example', 'sentry', 'wixpress', 'wordpress', 'yoursite', 'johndoe', 'uetr', 'bootstrap', 'jquery', 'fontawesome']):
                if em_low not in found:
                    found.append(em_low)
    return found

def check_fixed_row(item):
    url = str(item.get("url") or "").strip()
    country = item.get("country")
    if not url.startswith("http"):
        return None
    mobiles = []
    emails = []
    ext_website = None
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        html = urllib.request.urlopen(req, timeout=8, context=ctx).read().decode('utf-8', errors='ignore')
        
        # If maligah.com, remove header/footer before scanning
        body = html
        if 'maligah.com' in url:
            # Remove footer
            if '<footer' in body:
                body = body.split('<footer')[0]
        
        mobiles.extend(extract_mobiles(body, country))
        emails.extend(extract_emails(body))
        
        # Look for external website link on directory page
        for href in re.findall(r'href=["\'](https?://[^"\']+)["\']', body, flags=re.IGNORECASE):
            h_low = href.lower()
            if not any(d in h_low for d in PORTAL_DOMAINS) and not any(h_low.endswith(ext) for ext in BAD_EMAIL_EXTS):
                ext_website = href
                break
        
        # If we found an external website on the directory page, fetch it!
        if ext_website and (not mobiles or not emails):
            try:
                req2 = urllib.request.Request(ext_website, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
                html2 = urllib.request.urlopen(req2, timeout=6, context=ctx).read().decode('utf-8', errors='ignore')
                for m in extract_mobiles(html2, country):
                    if m not in mobiles: mobiles.append(m)
                for e in extract_emails(html2):
                    if e not in emails: emails.append(e)
            except Exception:
                pass
    except Exception:
        pass
    
    if mobiles or emails:
        return {
            "row": item["row"],
            "id": item["id"],
            "name": item["name"],
            "country": country,
            "mobiles": mobiles[:3],
            "emails": emails[:2],
            "ext_website": ext_website,
            "source_url": url
        }
    return None

results = []
with ThreadPoolExecutor(max_workers=20) as ex:
    futs = [ex.submit(check_fixed_row, r) for r in fixed_rows]
    for f in as_completed(futs):
        res = f.result()
        if res:
            results.append(res)

with open(r"c:\xampp\htdocs\app.gic-agropelc\scratch\directory_fixed_enriched.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

print(f"Checked {len(fixed_rows)} fixed-only rows -> Enriched {len(results)} rows from directory/external websites!")
