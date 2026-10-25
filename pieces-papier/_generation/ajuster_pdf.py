"""Ramène chaque PDF à sa taille exacte en mm (Chromium arrondit au pixel : +0,1 à +0,3 mm). Ancrage en haut à gauche.
Lancer : python -I pieces-papier/_generation/ajuster_pdf.py"""
from pathlib import Path
import pypdf
from pypdf.generic import RectangleObject
PT = 72 / 25.4
for f in sorted((Path(__file__).resolve().parents[1] / 'pdf').glob('*.pdf')):
    r = pypdf.PdfReader(str(f)); w = pypdf.PdfWriter()
    for page in r.pages:
        wm, hm = float(page.mediabox.width) / PT, float(page.mediabox.height) / PT
        W, H = round(wm) * PT, round(hm) * PT
        top = float(page.mediabox.top)
        box = RectangleObject([0, top - H, W, top])
        page.mediabox = box; page.cropbox = box; page.trimbox = box
        w.add_page(page)
    with open(f, 'wb') as out: w.write(out)
print('PDF ajustés')
