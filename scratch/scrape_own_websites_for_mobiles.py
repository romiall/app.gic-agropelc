import openpyxl
import re
import urllib.request
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

claude_path = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE_ENRICHI_CLAUDE.xlsx"
gemini_path = r"c:\xampp\htdocs\app.gic-agropelc\BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx"

wb_c = openpyxl.load_workbook(claude_path, read_only=True, data_only=True)
c_rows = list(wb_c["Base Contacts"].iter_rows(values_only=True))[1:]

# Also check Cibles secondaires, Numéros partagés, Pistes Facebook in Claude!
sec_rows = list(wb_c["Cibles secondaires"].iter_rows(values_only=True))[1:]
shared_rows = list(wb_c["Numéros partagés (à arbitrer)"].iter_rows(values_only=True))[1:]
fb_rows = list(wb_c["Pistes Facebook (sans tél.)"].iter_rows(values_only=True))[1:]
wb_c.close()

wb_g = openpyxl.load_workbook(gemini_path, read_only=True, data_only=True)
g_rows = list(wb_g["Base Contacts"].iter_rows(values_only=True))[1:]
wb_g.close()

# Check how many emails are in Pistes Facebook (sans tél.)!
fb_emails = 0
for r in fb_rows:
    if len(r) > 8 and r[8] and '@' in str(r[8]):
        fb_emails += 1
print(f"Emails in 'Pistes Facebook (sans tél.)': {fb_emails}")

# Identify all fixed-only rows in Claude Base Contacts
def is_fixed_digits(d):
    if d.startswith('237'): return d[3:].startswith('2')
    if d.startswith('241'): return d[3:].startswith(('01', '11', '011'))
    if d.startswith('242'): return d[3:].startswith('22')
    if d.startswith('240'): return d[3:].startswith(('333', '350', '33'))
    if d.startswith('235'): return d[3:].startswith('22')
    if d.startswith('236'): return d[3:].startswith('21')
    return False

def is_mobile_digits(d):
    if len(d) < 8: return False
    if d.startswith('237'): return d[3:].startswith('6') and len(d) == 12
    if d.startswith('241'): return not d[3:].startswith(('01', '11', '011')) and len(d) in (10, 11)
    if d.startswith('242'): return d[3:].startswith(('04', '05', '06')) and len(d) == 12
    if d.startswith('240'): return d[3:].startswith(('222', '555', '666')) and len(d) == 12
    if d.startswith('235'): return d[3:].startswith(('6', '9', '7')) and len(d) == 11
    if d.startswith('236'): return d[3:].startswith('7') and len(d) == 11
    return False

own_websites_to_scrape = []
for idx, r in enumerate(c_rows, 2):
    u = str(r[15] or '').strip()
    if u and u.startswith('http') and not any(d in u for d in ['maligah.com', 'goafricaonline.com', 'chadyp.com', 'facebook.com', 'tripadvisor', 'booking.com', 'expedia', 'pagesjaunes', 'cybo.com', 'vymaps', 'near-place', 'afrikta', 'petitfute', 'evendo']):
        own_websites_to_scrape.append((idx, r[1], r[4], r[9], r[12], u))

print(f"Total rows in Claude with own corporate website URL: {len(own_websites_to_scrape)}")

# Scrape these corporate websites in parallel to extract mobile phones and emails!
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch_site_contacts(item):
    idx, country, name, p1, email, url = item
    found_mobiles = set()
    found_emails = set()
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        html = urllib.request.urlopen(req, timeout=8, context=ctx).read().decode('utf-8', errors='ignore')
        
        # Extract emails
        for em in re.findall(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+', html):
            em_low = em.lower().strip('.')
            if not any(em_low.endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.js', '.css', '.woff', '.ttf']) and not any(bad in em_low for bad in ['example.', 'sentry.', 'wixpress.', 'wordpress.', 'domain.', 'email.', 'yoursite.']):
                found_emails.add(em_low)
                
        # Extract Cameroon / Gabon / CEMAC phones
        # Look for +237 6... or 6xx xx xx xx
        if 'cameroun' in str(country).lower():
            for m in re.findall(r'(?:\+237|00237|237)?[\s\.\-\(\)]*(6[\d\s\.\-]{7,11})', html):
                d = '237' + re.sub(r'\D', '', m)
                if len(d) == 12 and d.startswith('2376'):
                    found_mobiles.add(d)
        elif 'gabon' in str(country).lower():
            for m in re.findall(r'(?:\+241|00241|241)[\s\.\-\(\)]*(0?[67425][\d\s\.\-]{6,9})', html):
                d = '241' + re.sub(r'\D', '', m)
                if is_mobile_digits(d):
                    found_mobiles.add(d)
    except Exception:
        pass
    return idx, name, url, list(found_mobiles), list(found_emails)

results = []
with ThreadPoolExecutor(max_workers=16) as ex:
    futures = [ex.submit(fetch_site_contacts, item) for item in own_websites_to_scrape]
    for fut in as_completed(futures):
        res = fut.result()
        if res[3] or res[4]:
            results.append(res)

print(f"\nScraped {len(own_websites_to_scrape)} corporate websites -> Found contacts on {len(results)} sites!")
for r in results[:30]:
    print(f"  Row {r[0]} ({r[1]}): Mobiles={r[3][:3]} | Emails={r[4][:3]}")
