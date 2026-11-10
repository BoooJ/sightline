"""Génère une fixture de test (RawDemo tronqué) à partir d'une vraie démo.

Usage : python scripts/make_test_fixture.py <demo.dem> <dossier_sortie> [nb_rounds]
Garde tous les événements, mais seulement les ticks/grenades des N premiers rounds,
pour que la fixture soit commitable (quelques Mo) et utilisable sans démo (sessions cloud).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.parsing.extract import extract_raw, save_raw  # noqa: E402

demo, out = sys.argv[1], Path(sys.argv[2])
n_rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
min_round = 1

raw = extract_raw(demo, sample_rate=16, progress=lambda p, s: print(f"{p:3d}% {s}"))
ends = raw.events["round_end"].sort_values("tick")
ends = ends[ends["round"] >= 1]
cut = int(ends.iloc[n_rounds - 1]["tick"]) + 64 * 5
raw.ticks = raw.ticks[raw.ticks["tick"] <= cut].reset_index(drop=True)
raw.grenades = raw.grenades[raw.grenades["tick"] <= cut].reset_index(drop=True)
raw.throws = raw.throws[raw.throws["tick"] <= cut].reset_index(drop=True)
save_raw(raw, out)
(out / "TRUNCATED.json").write_text(json.dumps({"rounds_with_ticks": n_rounds, "last_tick": cut}), encoding="utf-8")
print("ok", out)
