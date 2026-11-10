# backend/app/stats/playbook.py
"""Playbook (équivalent du « tactic-spotter » d'EDGE) : comment une équipe joue ses rounds sur une carte.

Côté T, chaque round est classé à partir de ce qui est déjà stocké :
- **Eco** : eco ou semi-buy ;
- **Rush** : premier contact ≤ RUSH_S et au moins 3 T près du site visé (positions prises NEAR_AFTER_S après le contact) ;
- **Exécution** : au moins 3 T près du site visé et au moins EXEC_UTIL utilitaires lancés avant le contact ;
- **Default** : contact tardif (≥ DEFAULT_S) ou équipe dispersée au contact ;
- sinon **Exécution** (prise de site groupée sans gros paquet d'utilitaires) ;
- **Split** : prise de site (rush ou exécution) où les T arrivent par au moins deux chemins : SPLIT_LOOK_S avant, les
  joueurs qui finissent sur le site étaient à plus de SPLIT_D unités les uns des autres ;
- **Fake** : la bombe est posée sur un site alors qu'au moins FAKE_UTIL grenades des T ont atterri sur l'autre site
  (distance 3D) dans les FAKE_WINDOW_S secondes avant le plant.
(Définitions usuelles des guides : le split prend un site « par deux directions », le fake « simule une attaque avec
des utilitaires puis tourne vers l'autre site ».)
Site visé : site de pose, sinon site le plus fréquenté par les T vivants au contact (ou à 45 s).

Prise du site (t_c) : le premier de ces moments — au moins 3 T vivants dont le lieu le plus proche (même étage, 700 u
au plus) est BombsiteA ou BombsiteB pendant 1 s après 5 s de jeu ; la pose ; un T tué dans le lieu BombsiteX après 5 s
avec un autre T vivant à 1 300 u. Un « rush » dont la prise du site vient après 50 s est un default. Sous-types du
default : « puis exécution » (au moins 3 grenades T lancées entre t_c − 15 s et t_c + 3 s, éclatées à 900 u du lieu
pris), « puis prise » (moins de grenades), « aux duels » (pas de t_c), « sans prise » (pas de t_c, temps écoulé).
Pression : première fois avant la pose où 2 grenades T éclatent à 900 u d'un site en 5 s, ou 2 T y restent 1 s.
Rotation CT : un CT qui tenait l'autre site (1 300 u) le quitte, se rapproche de 800 u du site pressé et arrive à
1 300 u de lui dans les 15 s. Elle n'est mesurable (clé `rotation_measurable` de chaque round T) que si les centres de
A et B sont à plus de 1 300 u l'un de l'autre : plus près, un CT « tient » les deux à la fois et ne peut jamais
quitter l'un pour l'autre (Nuke : sites superposés, environ 435 u avec la distance 2D + 2·dz) ; `ct_rotation_s` vaut
alors None et les résumés (brief, débrief, scouting) ignorent ces rounds.

Côté CT : setup à 20 s après le freeze time (ou au premier contact s'il est plus tôt), soit le nombre de CT vivants
près de chaque site (affectés au plus proche), le reste étant « ailleurs »."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import NamedTuple

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta, level_for_z
from app.parsing.model import FLAG_ALIVE
from app.stats.roles import site_centers
from app.stats.timings import ZONE_R, place_centers  # timings n'importe pas playbook : pas d'import circulaire
from app.storage.frames_codec import decode_fields
from app.storage.models import BombEvent, Damage, Grenade, Kill, Match, Round, RoundFrames

RUSH_S, DEFAULT_S, EXEC_UTIL = 22, 38, 4
SPLIT_D, SPLIT_LOOK_S, FAKE_UTIL = 1700.0, 10, 3
FAKE_R, FAKE_WINDOW_S = 900.0, 40  # grenades « sur l'autre site » : à moins de FAKE_R, lancées dans les 40 s avant le plant
# default puis exécution : au moins LATE_EXEC_UTIL grenades des T autour de la prise du site (voir EXEC_BEFORE_S)
# (étude de la bibliothèque, octobre 2026 : un quart des rounds « default » finissent ainsi, pros comme FACEIT)
LATE_EXEC_UTIL = 3
NEAR_AFTER_S = 8  # délai après le premier contact pour compter les T près du site visé
SITE_R = 1300.0
CT_SETUP_S = 20
CATS = ("rush", "execute", "split", "fake", "default", "eco")
CAT_LABELS = {"rush": "Rush", "execute": "Exécution", "split": "Split", "fake": "Fake", "default": "Default", "eco": "Eco"}

# --- Default en phases (spec 2026-10-15 §3, calibré sur la bibliothèque de 13 démos le 2026-10-16) ---
ENGAGE_FROM_S = 5                 # la prise du site se cherche après 5 s de jeu
ENGAGE_MIN_T, ENGAGE_S = 3, 1.0   # au moins 3 T vivants sur le site pendant 1 s (en secondes, voir _images)
PLACE_R = ZONE_R                  # « sur le site » : lieu le plus proche (même étage) = BombsiteX, à 700 u au plus
ENGAGE_DEATH_R = SITE_R           # T tué dans le lieu BombsiteX : un autre T vivant à 1 300 u du centre du lieu…
ENGAGE_DEATH_SUPPORT = 1          # …au moins un
RUSH_ENGAGE_S = 50                # un « rush » dont la prise du site vient après 50 s (1:05) est un default
EXEC_BEFORE_S, EXEC_AFTER_S = 15, 3   # grenades d'exécution lancées entre t_c − 15 s et t_c + 3 s
EXEC_R = FAKE_R                   # 900 u du centre du lieu BombsiteX (repli : centre du site)
PRESS_R = 900.0                   # pression : à 900 u du centre d'un site…
PRESS_NADES, PRESS_NADE_S = 2, 5  # …2 grenades T éclatées en 5 s…
PRESS_T, PRESS_S = 2, 1.0         # …ou 2 T vivants pendant 1 s
ROT_FROM_R = SITE_R               # le CT tenait l'autre site (1 300 u) au moment de la pression
# rotation mesurable (rotation_measurable) seulement si les centres de A et B sont à plus de ROT_FROM_R (métrique de
# _dist) : en dessous, un CT qui tient un site tient aussi l'autre (Nuke : sites superposés, environ 435 u)
ROT_GAIN = 800.0                  # il se rapproche du site pressé d'au moins 800 u…
ROT_ARRIVE_R = SITE_R             # …arrive à 1 300 u du site pressé…
ROT_S = 15                        # …en 15 s au plus
NADE_TYPES = ("smoke", "flash", "molotov", "incendiary", "he")   # pas de leurre
DEFAULT_KINDS = ("exec", "take", "duels", "no_take")
DEFAULT_KIND_LABELS = {"exec": "Puis exécution", "take": "Puis prise", "duels": "Aux duels", "no_take": "Sans prise"}


def _dists(x, y, z, centers):
    out = {}
    for k, c in centers.items():
        d = np.hypot(x - c[0], y - c[1])
        if c[2] is not None:
            d = np.hypot(d, 2 * (z - c[2]))
        out[k] = d
    return out


def _closest_counts(x, y, z, alive, centers) -> dict[str, int]:
    """Nombre de joueurs vivants près de chaque site (chacun compté au site le plus proche, dans SITE_R)."""
    counts = {k: 0 for k in centers}
    if not centers:
        return counts
    d = _dists(x, y, z, centers)
    keys = list(d)
    stack = np.stack([d[k] for k in keys])
    best = stack.argmin(axis=0)
    for i, k in enumerate(keys):
        counts[k] = int(((best == i) & (stack[i] <= SITE_R) & alive).sum())
    return counts


# --- Default en phases : données d'un round T et fonctions pures (testées sans base) ------------------------------

class TNade(NamedTuple):
    """Grenade des T (tous types : util_before compte aussi les leurres)."""
    type: str
    throw_tick: int
    det_tick: int | None
    x: float | None          # point d'éclatement (Grenade.detonate_x/y/z)
    y: float | None
    z: float | None


class TDeath(NamedTuple):
    """T tué (Kill.victim_side == "T") ; les décès d'un round sont triés par tick."""
    tick: int
    col: int | None          # colonne du T tué dans t_x… (None s'il n'est pas dans les trames)
    place: str | None        # Kill.victim_place


@dataclass(frozen=True)
class SitePlaces:
    """Centres des lieux de la carte (timings.place_centers, lieux à 3 kills ou plus) et bornes z de leur étage."""
    names: tuple[str, ...]
    cx: np.ndarray
    cy: np.ndarray
    cz: np.ndarray
    zlo: np.ndarray          # bornes z de l'étage du lieu ; ±inf sur une carte à un niveau
    zhi: np.ndarray
    site_idx: dict[str, int]  # {"A": index de BombsiteA, "B": …}, seulement les lieux présents


@dataclass
class TRoundCtx:
    """Tout ce qu'il faut pour classer un round T, sans session."""
    rate: int                # demo_tickrate
    fps: int                 # images par seconde de la démo (sample_rate du match)
    t0: int                  # freeze_end_tick
    end_tick: int
    buy: str | None          # r.t_buy_type
    end_reason: str | None   # t_killed | ct_killed | bomb_defused | bomb_exploded | time_ran_out
    ticks: np.ndarray        # (n,) images, fps par seconde
    t_x: np.ndarray          # (n, kT)
    t_y: np.ndarray
    t_z: np.ndarray
    t_alive: np.ndarray
    ct_x: np.ndarray         # (n, kCT)
    ct_y: np.ndarray
    ct_z: np.ndarray
    ct_alive: np.ndarray
    contact_tick: int | None  # premiers dégâts entre camps, >= t0
    plant_tick: int | None
    plant_site: str | None    # "A"/"B" seulement, sinon None
    nades: list[TNade]
    deaths: list[TDeath]
    sites: dict[str, tuple]   # roles.site_centers (x, y, z|None)
    places: SitePlaces | None  # None : la prise du site ne vient que de la pose


def _window(ctx: TRoundCtx) -> tuple[np.ndarray, np.ndarray]:
    secs = (ctx.ticks - ctx.t0) / ctx.rate
    return secs, (secs >= 0) & (ctx.ticks <= ctx.end_tick)


def _images(ctx: TRoundCtx, seconds: float) -> int:
    """Nombre d'images qui couvrent `seconds` secondes dans la démo du round (à son taux d'images, fps)."""
    return max(1, round(seconds * ctx.fps))


def _first_run(ok: np.ndarray, n: int) -> int | None:
    """Premier indice qui ouvre n valeurs vraies consécutives (None s'il n'y en a pas)."""
    c = np.concatenate([[0], np.cumsum(ok.astype(np.int32))])
    w = np.flatnonzero((c[n:] - c[:-n]) == n)
    return int(w[0]) if len(w) else None


def _dist(x, y, z, c):
    """Métrique de _dists pour un seul centre : 2D, plus 2·dz quand le centre (et le point) ont un z."""
    d = np.hypot(x - c[0], y - c[1])
    if c[2] is not None and z is not None:
        d = np.hypot(d, 2 * (z - c[2]))
    return d


def _site_places_from(meta: MapMeta, centers: dict[str, tuple]) -> SitePlaces | None:
    if not centers:
        return None
    names = tuple(centers)
    multi = len(meta.levels) >= 2
    bounds = []
    for p in names:
        if multi:
            lvl = next(lv for lv in meta.levels if lv.name == level_for_z(meta, centers[p][2]))
            bounds.append((lvl.z_min, lvl.z_max))
        else:
            bounds.append((-np.inf, np.inf))
    a = lambda i: np.array([centers[p][i] for p in names], dtype=float)  # noqa: E731
    return SitePlaces(names, a(0), a(1), a(2), np.array([b[0] for b in bounds], dtype=float),
                      np.array([b[1] for b in bounds], dtype=float),
                      {p[-1]: i for i, p in enumerate(names) if p in ("BombsiteA", "BombsiteB")})


def site_places(session: Session, meta: MapMeta | None) -> SitePlaces | None:
    return _site_places_from(meta, place_centers(session, meta)) if meta is not None else None


def site_membership(pl: SitePlaces, x, y, z, mask: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """{"A": bool (même forme que x), "B": …} : le lieu le plus proche sur le même étage est BombsiteX, à PLACE_R au
    plus. Exact : on ne cherche le lieu le plus proche que pour les positions déjà à PLACE_R du centre de BombsiteX
    (les autres ne peuvent pas y être), et seulement parmi les lieux à 2·PLACE_R de ce centre (inégalité
    triangulaire : un lieu plus éloigné ne peut pas être plus proche qu'elle de ces positions). `mask` : positions à
    considérer (les autres valent False)."""
    out = {}
    for s, j in pl.site_idx.items():
        m = (np.hypot(x - pl.cx[j], y - pl.cy[j]) <= PLACE_R) & (z >= pl.zlo[j]) & (z < pl.zhi[j])
        if mask is not None:
            m &= mask
        if m.any():
            k = np.flatnonzero(np.hypot(pl.cx - pl.cx[j], pl.cy - pl.cy[j]) <= 2 * PLACE_R + 1.0)   # contient j
            px, py, pz = x[m], y[m], z[m]
            d = np.hypot(px[:, None] - pl.cx[k], py[:, None] - pl.cy[k])
            d[~((pz[:, None] >= pl.zlo[k]) & (pz[:, None] < pl.zhi[k]))] = np.inf
            m[m] = k[d.argmin(axis=1)] == j   # à égalité, le premier lieu dans l'ordre de place_centers
        out[s] = m
    return out


def _span(ok: np.ndarray) -> slice:
    """Plus petite plage d'images qui contient tous les True de ok (vide s'il n'y en a pas)."""
    w = np.flatnonzero(ok)
    return slice(int(w[0]), int(w[-1]) + 1) if len(w) else slice(0, 0)


def engagement(ctx: TRoundCtx) -> tuple[float | None, str | None]:
    """Prise du site t_c (secondes brutes après le freeze time) et site pris : le premier de ces moments — au moins
    ENGAGE_MIN_T T vivants sur le site pendant ENGAGE_S secondes après ENGAGE_FROM_S ; la pose ; un T tué dans le
    lieu BombsiteX après ENGAGE_FROM_S avec ENGAGE_DEATH_SUPPORT autre T vivant à ENGAGE_DEATH_R du centre du lieu.
    Rien après la fin du round (end_tick)."""
    secs, win = _window(ctx)
    best = None
    pl = ctx.places
    if pl is not None and pl.site_idx:
        ok = win & (secs >= ENGAGE_FROM_S)
        sl = _span(ok)   # seuls comptent les T vivants des images de la fenêtre où ils sont au moins ENGAGE_MIN_T
        al = ctx.t_alive[sl]
        on = site_membership(pl, ctx.t_x[sl], ctx.t_y[sl], ctx.t_z[sl],
                             al & ((al.sum(axis=1) >= ENGAGE_MIN_T) & ok[sl])[:, None])
        for s in ("A", "B"):
            if s in on:
                i = _first_run(on[s].sum(axis=1) >= ENGAGE_MIN_T, _images(ctx, ENGAGE_S))
                if i is not None:
                    i += sl.start
                    if best is None or secs[i] < best[0]:
                        best = (float(secs[i]), s)
    # pose et morts pendant le délai de fin de round (après end_tick) : le round est déjà joué
    if ctx.plant_tick is not None and ctx.plant_tick <= ctx.end_tick:
        ps = (ctx.plant_tick - ctx.t0) / ctx.rate
        if best is None or ps < best[0]:
            best = (ps, ctx.plant_site)
    if pl is not None:
        for d in ctx.deaths:
            ks = (d.tick - ctx.t0) / ctx.rate
            if d.tick > ctx.end_tick or (best is not None and ks >= best[0]):
                break
            j = pl.site_idx.get(d.place[-1]) if d.place in ("BombsiteA", "BombsiteB") else None
            if ks < ENGAGE_FROM_S or j is None:
                continue
            i = int(np.clip(np.searchsorted(ctx.ticks, d.tick), 0, len(ctx.ticks) - 1))
            near = (_dist(ctx.t_x[i], ctx.t_y[i], ctx.t_z[i], (pl.cx[j], pl.cy[j], pl.cz[j])) <= ENGAGE_DEATH_R) & ctx.t_alive[i]
            if int(near.sum()) - (1 if d.col is not None and near[d.col] else 0) >= ENGAGE_DEATH_SUPPORT:
                best = (ks, d.place[-1])
                break
    return best if best else (None, None)


def pressure(ctx: TRoundCtx) -> tuple[float | None, str | None]:
    """Première pression des T sur un site avant la pose (secondes brutes, site) : PRESS_NADES grenades éclatées à
    PRESS_R du centre en PRESS_NADE_S (heure de la dernière), ou PRESS_T T vivants pendant PRESS_S secondes (heure
    de la première image)."""
    secs, win = _window(ctx)
    if not win.any():
        return None, None
    end_s = float(secs[win][-1])
    if ctx.plant_tick is not None:
        end_s = min(end_s, (ctx.plant_tick - ctx.t0) / ctx.rate)
    cands = []
    sl = _span(win)
    for s, c in ctx.sites.items():
        ts = sorted(t for t in (((g.det_tick if g.det_tick is not None else g.throw_tick) - ctx.t0) / ctx.rate
                                for g in ctx.nades if g.type in NADE_TYPES and g.x is not None
                                and float(_dist(g.x, g.y, g.z, c)) <= PRESS_R) if t >= 0)
        for a in range(len(ts) - PRESS_NADES + 1):
            b = ts[a + PRESS_NADES - 1]
            if b - ts[a] <= PRESS_NADE_S:
                if b <= end_s:
                    cands.append((b, s))
                break
        cnt = ((_dist(ctx.t_x[sl], ctx.t_y[sl], ctx.t_z[sl], c) <= PRESS_R) & ctx.t_alive[sl]).sum(axis=1)
        i = _first_run((cnt >= PRESS_T) & win[sl], _images(ctx, PRESS_S))
        if i is not None and secs[i + sl.start] <= end_s:
            cands.append((float(secs[i + sl.start]), s))
    return min(cands) if cands else (None, None)


def rotation_measurable(sites: dict[str, tuple]) -> bool:
    """La rotation CT se mesure seulement si A et B sont connus et que leurs centres sont à plus de ROT_FROM_R l'un de
    l'autre (même métrique que _dist) ; sinon un CT qui tient un site tient aussi l'autre (Nuke)."""
    if "A" not in sites or "B" not in sites:
        return False
    a, b = sites["A"], sites["B"]
    return float(_dist(a[0], a[1], a[2], b)) > ROT_FROM_R


def ct_rotation(ctx: TRoundCtx, pressure_s: float | None, pressure_site: str | None) -> float | None:
    """Rotation CT provoquée par la pression : un CT vivant qui tenait l'autre site (ROT_FROM_R) le quitte, se
    rapproche du site pressé d'au moins ROT_GAIN et arrive à ROT_ARRIVE_R de lui dans les ROT_S secondes. None si la
    rotation n'est pas mesurable sur la carte (rotation_measurable)."""
    other = {"A": "B", "B": "A"}.get(pressure_site)
    if pressure_s is None or other not in ctx.sites or pressure_site not in ctx.sites or not ctx.ct_x.shape[1]:
        return None
    if not rotation_measurable(ctx.sites):
        return None
    secs, win = _window(ctx)
    i0 = int(np.clip(np.searchsorted(secs, pressure_s), 0, len(secs) - 1))
    sl = slice(i0, int(np.searchsorted(secs, pressure_s + ROT_S, side="right")))
    do = _dist(ctx.ct_x[sl], ctx.ct_y[sl], ctx.ct_z[sl], ctx.sites[other])
    dp = _dist(ctx.ct_x[sl], ctx.ct_y[sl], ctx.ct_z[sl], ctx.sites[pressure_site])
    al = ctx.ct_alive[sl] & win[sl, None]
    held = al[0] & (do[0] <= ROT_FROM_R)
    hit = al & held[None, :] & (do > ROT_FROM_R) & ((dp[0] - dp) >= ROT_GAIN) & (dp <= ROT_ARRIVE_R)
    rows = np.flatnonzero(hit.any(axis=1))
    return float(secs[i0 + rows[0]]) if len(rows) else None


def default_kind(ctx: TRoundCtx, engage_s: float | None, engage_site: str | None) -> str:
    """Fin d'un default : exec (au moins LATE_EXEC_UTIL grenades T lancées entre t_c − 15 s et t_c + 3 s, éclatées à
    EXEC_R du lieu pris), take (moins), duels (pas de t_c), no_take (pas de t_c, temps écoulé)."""
    if engage_s is None:
        return "no_take" if ctx.end_reason == "time_ran_out" else "duels"
    pl, c = ctx.places, None
    if engage_site in ("A", "B"):
        if pl is not None and engage_site in pl.site_idx:
            j = pl.site_idx[engage_site]
            c = (pl.cx[j], pl.cy[j], pl.cz[j])
        else:
            c = ctx.sites.get(engage_site)
    if c is None:
        return "take"
    lo, hi = engage_s - EXEC_BEFORE_S, engage_s + EXEC_AFTER_S
    n = sum(1 for g in ctx.nades if g.type in NADE_TYPES and g.x is not None
            and lo <= (g.throw_tick - ctx.t0) / ctx.rate <= hi and float(_dist(g.x, g.y, g.z, c)) <= EXEC_R)
    return "exec" if n >= LATE_EXEC_UTIL else "take"


def _r1(v: float | None) -> float | None:
    return round(float(v), 1) if v is not None else None


def classify_t_round(ctx: TRoundCtx) -> dict:
    """Catégorie d'un round T (règles du docstring du module), prise du site, sous-type du default, pression et
    rotation CT (`rotation_measurable` : False sur une carte aux sites trop proches, où `ct_rotation_s` vaut toujours
    None). Les secondes ne sont arrondies qu'à la sortie."""
    rate, t0, centers = ctx.rate, ctx.t0, ctx.sites
    idx = lambda tick: int(np.clip(np.searchsorted(ctx.ticks, tick), 0, len(ctx.ticks) - 1))  # noqa: E731
    contact = ctx.contact_tick
    at = contact if contact is not None else t0 + 45 * rate
    # positions évaluées NEAR_AFTER_S après le premier contact : au contact même, un rush n'est pas encore sur le
    # site (les premiers tirs ont lieu à l'approche) ; à +8 s, l'équipe a eu le temps d'arriver
    near_at = min(at + NEAR_AFTER_S * rate, t0 + 45 * rate) if contact is not None else at
    i = idx(near_at)
    x, y, z = ctx.t_x[i], ctx.t_y[i], ctx.t_z[i]
    near = _closest_counts(x, y, z, ctx.t_alive[i], centers)
    site = ctx.plant_site or (max(near, key=near.get) if near and max(near.values()) > 0 else None)
    n_site = near.get(site, 0) if site else 0
    util = sum(1 for g in ctx.nades if t0 <= g.throw_tick <= at)
    contact_s = (contact - t0) / rate if contact is not None else None
    plant_s = (ctx.plant_tick - t0) / rate if ctx.plant_tick is not None else None
    engage_s, engage_site = engagement(ctx)
    if ctx.buy in ("eco", "semi"):
        cat = "eco"
    elif contact_s is not None and contact_s <= RUSH_S and n_site >= 3:
        # un rush dont la prise du site vient après RUSH_ENGAGE_S est un default (pas de retombée sur « execute »,
        # pas de split)
        cat = "default" if engage_s is not None and engage_s > RUSH_ENGAGE_S else "rush"
    elif n_site >= 3 and util >= EXEC_UTIL:
        cat = "execute"
    elif contact_s is None or contact_s >= DEFAULT_S or n_site < 3:
        cat = "default"
    else:
        cat = "execute"
    if cat in ("rush", "execute") and site:
        # split : les T qui finissent sur le site venaient de chemins éloignés SPLIT_LOOK_S plus tôt
        near_d = _dists(x, y, z, {site: centers[site]})[site]
        on_site = [k for k in range(len(x)) if ctx.t_alive[i, k] and near_d[k] <= SITE_R]
        j0 = idx(max(t0, near_at - SPLIT_LOOK_S * rate))
        px, py = ctx.t_x[j0], ctx.t_y[j0]
        spread = max((float(np.hypot(px[a] - px[b], py[a] - py[b])) for a in on_site for b in on_site if a < b), default=0.0)
        if len(on_site) >= 3 and spread > SPLIT_D:
            cat = "split"
    if cat != "eco" and ctx.plant_tick is not None and ctx.plant_site is not None:
        other = "B" if ctx.plant_site == "A" else "A"
        if other in centers:
            oc = centers[other]   # distance 3D : sur Nuke, A et B sont l'un au-dessus de l'autre
            lo = max(t0, ctx.plant_tick - FAKE_WINDOW_S * rate)
            fake_util = sum(1 for g in ctx.nades if lo <= g.throw_tick <= ctx.plant_tick and g.x is not None
                            and g.type in NADE_TYPES and float(_dist(g.x, g.y, g.z, oc)) <= FAKE_R)
            if fake_util >= FAKE_UTIL:
                cat = "fake"
    kind = default_kind(ctx, engage_s, engage_site) if cat == "default" else None
    p_s, p_site = pressure(ctx)
    rot = ct_rotation(ctx, p_s, p_site)
    return {"category": cat, "site": site, "contact_s": _r1(contact_s), "plant_s": _r1(plant_s), "util_before": util,
            "near_site": n_site, "late_exec": kind == "exec", "engage_s": _r1(engage_s),
            "engage_site": engage_site if engage_s is not None else None, "default_kind": kind,
            "pressure_s": _r1(p_s), "pressure_site": p_site, "ct_rotation_s": _r1(rot),
            "rotation_measurable": rotation_measurable(centers)}


def _match_rows(session: Session, m: Match, team_id: int, centers: dict[str, tuple],
                places: SitePlaces | None) -> tuple[list[dict], list[dict]]:
    """Lignes T et CT d'un match pour une équipe (requêtes et décodage des trames ; le classement T est pur)."""
    side_team = {mp.steamid: mp.team_id for mp in m.players}
    t_rounds, ct_rounds = [], []
    for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
        is_t = r.t_team_id == team_id
        fr = session.get(RoundFrames, r.id)
        if fr is None:
            continue
        fd = decode_fields(fr.blob)
        rate = m.demo_tickrate
        fps = m.sample_rate
        t0 = r.freeze_end_tick
        side_of = {sid: ("CT" if tid == r.ct_team_id else "T") for sid, tid in side_team.items()}
        # premier contact : premiers dégâts entre camps après le freeze time
        contact = session.scalar(select(Damage.tick).where(Damage.round_id == r.id, Damage.tick >= t0,
                                                          Damage.attacker_side.is_not(None),
                                                          Damage.attacker_side != Damage.victim_side)
                                 .order_by(Damage.tick).limit(1))
        plant = session.scalar(select(BombEvent).where(BombEvent.round_id == r.id, BombEvent.type == "plant")
                               .order_by(BombEvent.tick).limit(1))
        won = r.winner_side == ("T" if is_t else "CT")
        base = {"round_id": r.id, "match_id": m.id, "number": r.number, "won": won,
                "opponent": m.team_b.name if m.team_a_id == team_id else m.team_a.name}
        idx = lambda tick: int(np.clip(np.searchsorted(fd.ticks, tick), 0, len(fd.ticks) - 1))  # noqa: E731
        sides = np.array([side_of.get(s, "?") for s in fd.players])
        alive_all = (fd.fields["flags"] & FLAG_ALIVE) > 0
        if is_t:
            tcols, ccols = np.where(sides == "T")[0], np.where(sides == "CT")[0]
            # une seule requête Grenade par round, sur les colonnes (sans le blob de trajectoire)
            nades = [TNade(g.type, g.throw_tick, g.detonate_tick, g.detonate_x, g.detonate_y, g.detonate_z)
                     for g in session.execute(select(Grenade.type, Grenade.thrower, Grenade.throw_tick, Grenade.detonate_tick,
                                                     Grenade.detonate_x, Grenade.detonate_y, Grenade.detonate_z)
                                              .where(Grenade.round_id == r.id))
                     if side_of.get(g.thrower) == "T"]
            col = {fd.players[c]: k for k, c in enumerate(tcols)}
            deaths = [TDeath(k.tick, col.get(k.victim), k.victim_place)
                      for k in session.execute(select(Kill.tick, Kill.victim, Kill.victim_place)
                                               .where(Kill.round_id == r.id, Kill.victim_side == "T").order_by(Kill.tick))]
            fx, fy, fz = fd.fields["x"], fd.fields["y"], fd.fields["z"]
            ctx = TRoundCtx(rate=rate, fps=fps, t0=t0, end_tick=r.end_tick, buy=r.t_buy_type, end_reason=r.end_reason,
                            ticks=fd.ticks, t_x=fx[:, tcols], t_y=fy[:, tcols], t_z=fz[:, tcols], t_alive=alive_all[:, tcols],
                            ct_x=fx[:, ccols], ct_y=fy[:, ccols], ct_z=fz[:, ccols], ct_alive=alive_all[:, ccols],
                            contact_tick=contact, plant_tick=plant.tick if plant is not None else None,
                            plant_site=plant.site if plant is not None and plant.site in ("A", "B") else None,
                            nades=nades, deaths=deaths, sites=centers, places=places)
            t_rounds.append({**base, "buy": r.t_buy_type, **classify_t_round(ctx)})
        else:
            cols = np.where(sides == "CT")[0]
            at = min(t0 + CT_SETUP_S * rate, contact) if contact is not None else t0 + CT_SETUP_S * rate
            i = idx(at)
            alive = alive_all[i, cols]
            counts = _closest_counts(fd.fields["x"][i, cols], fd.fields["y"][i, cols], fd.fields["z"][i, cols],
                                     alive, centers)
            other = int(alive.sum()) - sum(counts.values())
            label = " · ".join([f"{k}{counts.get(k, 0)}" for k in ("A", "B")] + ([f"{other} ailleurs"] if other else []))
            # site attaqué par les T (pose, sinon site le plus fréquenté par les T au contact ou à 45 s)
            tcols = np.where(sides == "T")[0]
            ia = idx(contact if contact is not None else t0 + 45 * rate)
            tnear = _closest_counts(fd.fields["x"][ia, tcols], fd.fields["y"][ia, tcols], fd.fields["z"][ia, tcols],
                                    alive_all[ia, tcols], centers)
            planted = plant.site if plant is not None and plant.site in ("A", "B") else None
            attacked = planted or (max(tnear, key=tnear.get) if tnear and max(tnear.values()) >= 2 else None)
            ct_rounds.append({**base, "setup": label, "counts": {**counts, "other": other}, "buy": r.ct_buy_type,
                              "attacked": attacked, "planted": planted})
    return t_rounds, ct_rounds


def team_playbook(session: Session, maps: dict[str, MapMeta], team_id: int, map_name: str) -> dict:
    centers = site_centers(session, maps, map_name)
    places = site_places(session, maps.get(map_name))   # une fois par appel : centres des lieux et étages
    matches = list(session.scalars(select(Match).where(Match.map_name == map_name,
                                                        (Match.team_a_id == team_id) | (Match.team_b_id == team_id))))
    t_rounds, ct_rounds = [], []
    for m in matches:
        t, c = _match_rows(session, m, team_id, centers, places)
        t_rounds += t
        ct_rounds += c
    t_sites = defaultdict(lambda: defaultdict(int))
    for x in t_rounds:
        t_sites[x["category"]][x["site"] or "none"] += 1
    contacts = [x["contact_s"] for x in t_rounds if x["contact_s"] is not None and x["category"] != "eco"]
    plants = [x["plant_s"] for x in t_rounds if x["plant_s"] is not None]
    return {
        "map": map_name, "team_id": team_id,
        "t": {"rounds": len(t_rounds), "categories": _summarize(t_rounds, "category", list(CATS)),
              "sites_by_category": {k: dict(v) for k, v in t_sites.items()},
              "avg_contact_s": round(float(np.mean(contacts)), 1) if contacts else None,
              "avg_plant_s": round(float(np.mean(plants)), 1) if plants else None, "list": t_rounds,
              # sous-types des defaults (pct : part des defaults) et prise des sites (rounds hors eco)
              "default_kinds": _summarize([x for x in t_rounds if x["category"] == "default"], "default_kind",
                                          list(DEFAULT_KINDS), DEFAULT_KIND_LABELS),
              "engage_by_site": engage_summary(t_rounds)},
        "ct": {"rounds": len(ct_rounds), "setups": _summarize(ct_rounds, "setup"), "list": ct_rounds,
               "sites": _site_defense(ct_rounds)},
    }


def match_t_rounds(session: Session, maps: dict[str, MapMeta], match_id: int, team_id: int) -> list[dict]:
    """Lignes T du playbook pour un seul match (débrief) ; [] si le match n'existe pas ou si l'équipe ne l'a pas joué."""
    m = session.get(Match, match_id)
    if m is None or team_id not in (m.team_a_id, m.team_b_id):
        return []
    return _match_rows(session, m, team_id, site_centers(session, maps, m.map_name),
                       site_places(session, maps.get(m.map_name)))[0]


def _summarize(rows: list[dict], key: str, order: list[str] | None = None,
               labels: dict[str, str] = CAT_LABELS) -> list[dict]:
    groups: dict[str, dict] = defaultdict(lambda: {"n": 0, "won": 0, "rounds": []})
    for x in rows:
        g = groups[x[key]]
        g["n"] += 1
        g["won"] += x["won"]
        g["rounds"].append(x["round_id"])
    keys = order or sorted(groups, key=lambda k: -groups[k]["n"])
    total = max(1, len(rows))
    return [{"key": k, "label": labels.get(k, k), **groups[k], "pct": round(100 * groups[k]["n"] / total, 1),
             "win_pct": round(100 * groups[k]["won"] / groups[k]["n"], 1) if groups[k]["n"] else 0.0}
            for k in keys if groups[k]["n"]]


def engage_summary(rows: list[dict]) -> dict:
    """Prise des sites sur les rounds T hors eco : par site, nombre, rounds gagnés et heure (médiane, quartiles) ;
    « none » compte les rounds sans prise ou à site inconnu (A.n + B.n + none = rounds hors eco)."""
    armed = [x for x in rows if x["category"] != "eco"]
    out: dict = {}
    for s in ("A", "B"):
        xs = [x for x in armed if x["engage_s"] is not None and x["engage_site"] == s]
        p25, med, p75 = (round(float(v), 1) for v in np.percentile([x["engage_s"] for x in xs], (25, 50, 75))) \
            if xs else (None, None, None)
        won = sum(x["won"] for x in xs)
        out[s] = {"n": len(xs), "won": won, "win_pct": round(100 * won / len(xs), 1) if xs else 0.0,
                  "rounds": [x["round_id"] for x in xs], "median_s": med, "p25_s": p25, "p75_s": p75}
    out["none"] = len(armed) - out["A"]["n"] - out["B"]["n"]
    return out


def _site_defense(ct_rounds: list[dict]) -> dict[str, dict]:
    """Défense par site (« hold success » d'EDGE) : rounds où le site a été attaqué, tenus sans pose, retakes."""
    out = {k: {"attacked": 0, "held": 0, "plants": 0, "retakes_won": 0} for k in ("A", "B")}
    for x in ct_rounds:
        site = x.get("attacked")
        if site not in out:
            continue
        d = out[site]
        d["attacked"] += 1
        if x.get("planted") == site:
            d["plants"] += 1
            d["retakes_won"] += x["won"]
        elif x["won"]:
            d["held"] += 1
    for d in out.values():
        d["hold_pct"] = round(100 * d["held"] / d["attacked"], 1) if d["attacked"] else 0.0
        d["retake_pct"] = round(100 * d["retakes_won"] / d["plants"], 1) if d["plants"] else 0.0
    return out
