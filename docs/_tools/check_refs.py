#!/usr/bin/env python3
"""Contrôle de cohérence des références de la documentation GIC AGROPELC.

Usage :
    python3 docs/_tools/check_refs.py            # contrôle, code retour 1 si référence orpheline
    python3 docs/_tools/check_refs.py --index    # régénère docs/01-functional/05-index-regles-metier.md

Principe : chaque identifiant (AV, BR, INV, ADR, REQ, ECR, SM, NFR, RISK, AT, C) a UNE source de
définition (voir docs/00-reference/00-conventions.md §3). Le script extrait les identifiants définis,
puis vérifie que toute référence trouvée dans docs/ (et CLAUDE.md) pointe vers un identifiant défini.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"

# Motifs de référence (tels qu'écrits dans les documents)
PATTERNS = {
    "AV": re.compile(r"\bAV-\d{3}\b"),
    "BR": re.compile(r"\bBR-[A-Z]{3}-\d{3}\b"),
    "INV": re.compile(r"\bINV-[A-Z]{3}-\d{2}\b"),
    "ADR": re.compile(r"\bADR-\d{3}\b"),
    "REQ": re.compile(r"\bREQ-\d{3}\b"),
    "ECR": re.compile(r"\bECR-[A-Z]{3}-\d{2}\b"),
    "SM": re.compile(r"\bSM-[A-Z][A-Z-]*[A-Z]\b"),
    "NFR": re.compile(r"\bNFR-\d{2}\b"),
    "RISK": re.compile(r"\bRISK-\d{2}\b"),
    "AT": re.compile(r"\bAT-\d{3}\b"),
    "C": re.compile(r"\bC-\d{2}\b"),
}

# Définitions : (famille, fichier ou glob, regex de définition)
DEFINITIONS = [
    ("AV", "A-VALIDER.md", re.compile(r"^\|\s*(AV-\d{3})\s*\|", re.M)),
    ("BR", "01-functional/domaines/D*.md", re.compile(r"^\|\s*(BR-[A-Z]{3}-\d{3})\s*\|", re.M)),
    ("INV", "02-domain-model/01-invariants.md", re.compile(r"^\|\s*(INV-[A-Z]{3}-\d{2})\s*\|", re.M)),
    ("ADR", "decisions/ADR-*.md", re.compile(r"^#\s*(ADR-\d{3})\b", re.M)),
    ("REQ", "01-functional/00-exigences-sources.md", re.compile(r"^\|\s*(REQ-\d{3})\s*\|", re.M)),
    ("ECR", "01-functional/03-parcours-et-ecrans.md", re.compile(r"^\|\s*(ECR-[A-Z]{3}-\d{2})\s*\|", re.M)),
    ("SM", "04-workflows/machines-a-etats/*.md", re.compile(r"^#{2,3}\s*(SM-[A-Z][A-Z-]*[A-Z])\b", re.M)),
    ("NFR", "09-non-functional/01-exigences-non-fonctionnelles.md", re.compile(r"^\|\s*(NFR-\d{2})\s*\|", re.M)),
    ("RISK", "10-development-plan/03-registre-risques.md", re.compile(r"^\|\s*(RISK-\d{2})\s*\|", re.M)),
    ("AT", "09-non-functional/03-plan-de-tests.md", re.compile(r"^\|\s*(AT-\d{3})\s*\|", re.M)),
    ("C", "00-reference/01-compte-rendu-comprehension.md", re.compile(r"^\|\s*\*\*(C-\d{2})\*\*\s*\|", re.M)),
]


# Exemples ou mentions volontaires qui ne sont pas des références réelles
IGNORED_FILES = {"docs/00-reference/00-conventions.md"}  # contient des identifiants d'exemple
IGNORED_REFS = {"REQ-199", "ECR-PRD-05"}  # borne de plage ; identifiant explicitement non attribué


def md_files() -> list[Path]:
    files = sorted(DOCS.rglob("*.md"))
    claude = ROOT / "CLAUDE.md"
    if claude.exists():
        files.append(claude)
    return files


def collect_definitions() -> dict[str, set[str]]:
    defined: dict[str, set[str]] = {k: set() for k in PATTERNS}
    for family, pattern, rx in DEFINITIONS:
        for path in sorted(DOCS.glob(pattern)):
            defined[family].update(rx.findall(path.read_text(encoding="utf-8")))
    return defined


def check() -> int:
    defined = collect_definitions()
    missing: dict[str, dict[str, set[str]]] = {}
    for path in md_files():
        text = path.read_text(encoding="utf-8")
        rel = str(path.relative_to(ROOT))
        if rel in IGNORED_FILES:
            continue
        for family, rx in PATTERNS.items():
            for ref in set(rx.findall(text)):
                if ref not in defined[family] and ref not in IGNORED_REFS:
                    missing.setdefault(family, {}).setdefault(ref, set()).add(rel)
    print("Identifiants définis :", ", ".join(f"{k}={len(v)}" for k, v in defined.items()))
    if not missing:
        print("OK : aucune référence orpheline.")
        return 0
    print("Références orphelines :")
    for family in sorted(missing):
        for ref in sorted(missing[family]):
            print(f"  {ref}  <- {', '.join(sorted(missing[family][ref]))}")
    return 1


ROW_RX = re.compile(r"^\|\s*(BR-[A-Z]{3}-\d{3})\s*\|\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*$", re.M)


def short(text: str, n: int = 140) -> str:
    text = re.sub(r"\s+", " ", text.replace("**", ""))
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def write_index() -> None:
    lines = [
        "# Index des règles métier",
        "",
        "> Section 10 du format final (PM §48). **Fichier généré** par `python3 docs/_tools/check_refs.py --index` :",
        "> ne pas éditer à la main. La règle fait foi dans son fichier de domaine ; ce tableau n'en donne qu'un résumé tronqué.",
        "",
    ]
    total = 0
    for path in sorted((DOCS / "01-functional/domaines").glob("D*.md")):
        rows = ROW_RX.findall(path.read_text(encoding="utf-8"))
        if not rows:
            continue
        title = path.read_text(encoding="utf-8").splitlines()[0].lstrip("# ").strip()
        lines += [f"## {title}", "", f"Fichier : [`domaines/{path.name}`](domaines/{path.name})", "",
                  "| ID | Règle (résumé) | Statut |", "|---|---|---|"]
        for rid, rule, status in rows:
            lines.append(f"| {rid} | {short(rule)} | {status.strip()} |")
            total += 1
        lines.append("")
    lines.insert(5, f"Nombre total de règles : **{total}**.\n")
    (DOCS / "01-functional/05-index-regles-metier.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"Index écrit : {total} règles.")


if __name__ == "__main__":
    if "--index" in sys.argv:
        write_index()
    sys.exit(check())
