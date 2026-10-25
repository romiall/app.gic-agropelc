"""Prépare les variantes du logo officiel pour l'impression.

Source : « logo gic.png » (racine du dépôt, fourni par le porteur le 20/10/2026).
Sorties dans charte/ :
  logo-officiel.png      copie intacte de la source
  logo-couleur.png       recadré sur le contenu (sans le disque blanc vide), fond conservé blanc
  logo-1-encre.png       une seule encre (vert) : aplats pleins + tramés, pour l'offset 1 couleur
  logo-2-encres.png      vert + orange doré (les oeufs prennent l'encre d'accent)
  logo-blanc.png         silhouette blanche sur fond transparent, pour bandeau vert

Lancer :  python -I pieces-papier/_generation/preparer_logo.py
"""
from pathlib import Path
from PIL import Image
import shutil

RACINE = Path(__file__).resolve().parents[2]
SRC = RACINE / "logo gic.png"
OUT = RACINE / "pieces-papier" / "charte"
OUT.mkdir(parents=True, exist_ok=True)

VERT = (0x3A, 0x63, 0x51)      # bandeau du logo
ORANGE = (0xC8, 0x78, 0x0A)    # accent : or de l'oeuf poussé vers l'orange (lisibilité)

shutil.copyfile(SRC, OUT / "logo-officiel.png")
im = Image.open(SRC).convert("RGBA")
w, h = im.size
px = im.load()

# Boîte englobante du contenu (hors disque blanc)
xs, ys = [], []
for y in range(0, h, 2):
    for x in range(0, w, 2):
        r, g, b, a = px[x, y]
        if a > 200 and (r < 235 or g < 235 or b < 235):
            xs.append(x)
            ys.append(y)
PAD = 24
box = (max(min(xs) - PAD, 0), max(min(ys) - PAD, 0), min(max(xs) + PAD, w), min(max(ys) + PAD, h))
print("boîte de contenu", box)

crop = im.crop(box)
fond = Image.new("RGBA", crop.size, (255, 255, 255, 255))
fond.alpha_composite(crop)
couleur = fond.convert("RGB")
couleur.thumbnail((1500, 1500), Image.LANCZOS)
couleur.save(OUT / "logo-couleur.png", optimize=True)


def couverture(r, g, b):
    """Part d'encre (0..1) selon la luminance : sombre = plein, clair = tramé, blanc = rien."""
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if lum <= 110:
        return 1.0
    if lum >= 250:
        return 0.0
    return (250 - lum) / 140.0


def jaune(r, g, b):
    return (r - b) > 45 and r > g - 12


src = fond.copy()
src.thumbnail((1500, 1500), Image.LANCZOS)
sp = src.load()
W, H = src.size
v1 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
v2 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
vb = Image.new("RGBA", (W, H), (0, 0, 0, 0))
p1, p2, pb = v1.load(), v2.load(), vb.load()
for y in range(H):
    for x in range(W):
        r, g, b, _ = sp[x, y]
        c = couverture(r, g, b)
        if c <= 0:
            continue
        a = int(round(c * 255))
        p1[x, y] = (*VERT, a)
        p2[x, y] = (*(ORANGE if jaune(r, g, b) else VERT), a)
        pb[x, y] = (255, 255, 255, a)
v1.save(OUT / "logo-1-encre.png", optimize=True)
v2.save(OUT / "logo-2-encres.png", optimize=True)
vb.save(OUT / "logo-blanc.png", optimize=True)
print("ok", W, H)
