"""Convertit maps/_source (overviews Valve + PNG) au format interne maps/<map>.json.

Usage : python scripts/build_maps.py  (depuis la racine du projet)
Une future version pourra extraire ces mêmes fichiers depuis l'installation de CS2.
"""
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC, DST = ROOT / "maps" / "_source", ROOT / "maps"
DISPLAY = {"de_ancient": "Ancient", "de_anubis": "Anubis", "de_dust2": "Dust II", "de_inferno": "Inferno",
           "de_mirage": "Mirage", "de_nuke": "Nuke", "de_overpass": "Overpass", "de_train": "Train",
           "de_vertigo": "Vertigo", "de_cache": "Cache"}
# pool compétitif actuel (Premier saison 5, juillet 2026 : Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke)
ACTIVE = {"de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"}
TOKEN = re.compile(r'"([^"]*)"|(\{)|(\})')


def parse_kv(text: str) -> dict:
    text = re.sub(r"//[^\n]*", "", text)
    stack, key = [{}], None
    for m in TOKEN.finditer(text):
        s, open_, close = m.groups()
        if open_:
            d = {}
            stack[-1][key] = d
            stack.append(d)
            key = None
        elif close:
            stack.pop()
        elif key is None:
            key = s
        else:
            stack[-1][key] = s
            key = None
    return stack[0]


def convert(txt: Path) -> dict:
    name = txt.stem
    kv = next(iter(parse_kv(txt.read_text(encoding="utf-8", errors="ignore")).values()))
    levels = []
    vs = kv.get("verticalsections", {})
    for lname, sec in vs.items():
        image = f"{name}.png" if lname == "default" else f"{name}_{lname}.png"
        if (SRC / image).exists():
            levels.append({"name": "upper" if lname == "default" else lname, "image": image,
                           "z_min": float(sec.get("AltitudeMin", -100000)),
                           "z_max": float(sec.get("AltitudeMax", 100000))})
    if not levels:
        levels = [{"name": "default", "image": f"{name}.png", "z_min": -100000.0, "z_max": 100000.0}]
    bomb = lambda s: [float(kv[f"bomb{s}_x"]), float(kv[f"bomb{s}_y"])] if f"bomb{s}_x" in kv else None
    return {"name": name, "display_name": DISPLAY.get(name, name), "pos_x": float(kv["pos_x"]),
            "pos_y": float(kv["pos_y"]), "scale": float(kv["scale"]), "image": f"{name}.png",
            "levels": levels, "bomb_a": bomb("A"), "bomb_b": bomb("B"), "active_duty": name in ACTIVE}


def main() -> None:
    for txt in sorted(SRC.glob("*.txt")):
        meta = convert(txt)
        (DST / f"{meta['name']}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        for lvl in meta["levels"]:
            shutil.copyfile(SRC / lvl["image"], DST / lvl["image"])
        print("ok", meta["name"], [lvl["name"] for lvl in meta["levels"]])


if __name__ == "__main__":
    main()
