import { memo } from "react";
import type { Side } from "../../shared/api/types";
import { weaponLabel } from "../../shared/format";
import type { PlayerState } from "../replay/engine/state";
import { ArmorIcon, KitIcon, NadeIcon, WeaponIcon, weaponClass, type WeaponClass, weaponIconKey } from "../replay/hud";
import { type Board, type BoardKill, type BoardPlayer, type WeaponSlot, weaponSlots } from "./board";
import { scopeKind } from "./cameras";
import { crosshairShown } from "./crosshair";
import { CrosshairView } from "./CrosshairView";
import { MiniRadar, type RadarSource } from "./MiniRadar";
import { ScopeOverlay } from "./ScopeOverlay";
import type { CameraMode } from "./types";

/** Le HUD est dessiné (proportions relevées) pour une vue de 1080 px de haut, puis réduit d'un facteur
 *  « hauteur de la vue / 1080 » (627 px : 0,58 ; 939 px : 0,87) : mêmes proportions à toutes les tailles. Dans une vue
 *  étroite, le facteur est aussi borné par la largeur (`HUD_BASE_W`) : le radar, la barre de score et le bas ne se
 *  chevauchent pas. */
export const HUD_BASE_H = 1080, HUD_BASE_W = 1440;
/** Facteur d'échelle du HUD pour une vue de `w` × `h` px (variable CSS `--r3-k`, posée par `Scene3D` au redimensionnement). */
export const hudScale = (w: number, h: number) => (w > 0 && h > 0 ? Math.min(h / HUD_BASE_H, w / HUD_BASE_W) : 0);

/** Classes d'armes dont on affiche les munitions. Le couteau, le C4 et les grenades ont un chargeur à 0 dans les replays
 *  (et non null) : sans cette liste, leurs munitions s'afficheraient. */
const FIREARMS: ReadonlySet<WeaponClass> = new Set<WeaponClass>(["rifle", "sniper", "smg", "heavy", "pistol", "zeus"]);
/** Contenance du chargeur des armes du jeu (données publiques de CS2) : remplissage de la barre sous les munitions. */
const MAG: Readonly<Record<string, number>> = {
  "AK-47": 30, M4A4: 30, "M4A1-S": 20, FAMAS: 25, "Galil AR": 35, AUG: 30, "SG 553": 30, AWP: 5, "SSG 08": 10, "SCAR-20": 20,
  G3SG1: 20, MP9: 30, "MAC-10": 30, MP7: 30, "MP5-SD": 30, "UMP-45": 25, P90: 50, "PP-Bizon": 64, Nova: 8, XM1014: 7, "MAG-7": 5,
  "Sawed-Off": 7, Negev: 150, M249: 100, "Glock-18": 20, "USP-S": 12, P2000: 13, P250: 13, "Tec-9": 18, "Five-SeveN": 20,
  "CZ75-Auto": 12, "Desert Eagle": 7, "Dual Berettas": 30, "R8 Revolver": 8, "Zeus x27": 1,
};

/** « 1 point », « 2 points » (0 et 1 au singulier, comme en français). */
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
const lifeLabel = (hp: number) => `${plural(hp, "point")} de vie`;
const pct = (v: number) => Math.max(0, Math.min(100, v)) / 100;
const side = (s: string) => s.toLowerCase();
/** Argent comme le jeu : « $4550 », sans séparateur. */
const money = (n: number) => `$${n}`;

/** Portrait neutre : les replays n'ont pas d'avatar (ni avatar Steam ni logo d'équipe). */
function Face() {
  return (
    <svg className="r3-face" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="12.5" r="6.5" fill="currentColor" /><path d="M4 32c0-7.5 5.4-12 12-12s12 4.5 12 12z" fill="currentColor" />
    </svg>
  );
}

/** Pictogrammes dessinés pour Sightline (aucune image reprise du jeu ni d'ailleurs) : un par particularité de kill, la marque de
 *  kill des cartes, le joueur en vie, le chargeur de réserve, le bouclier vide. */
const MARKS = {
  blind: "M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8zm7 2.6A2.6 2.6 0 1 0 8 5.4a2.6 2.6 0 0 0 0 5.2zM2 14 14 2",
  noscope: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 1v4M8 11v4M1 8h4M11 8h4M2.5 13.5l11-11",
  smoke: "M4.5 12.5h7.2a2.8 2.8 0 0 0 .3-5.6 3.8 3.8 0 0 0-7.3-.9A3.3 3.3 0 0 0 4.5 12.5z",
  wallbang: "M5 1.5h6v13H5zM5 5.5h6M5 10h6M8 1.5v4M8 10v4.5M1 8h14M12.5 5.5 15 8l-2.5 2.5",
  headshot: "M8 2a5 5 0 0 1 5 5c0 1.8-.9 3-2 3.8V13H5v-2.2C3.9 10 3 8.8 3 7a5 5 0 0 1 5-5zM6.2 7.5h.1M9.7 7.5h.1M1 14.5h14",
} as const;
const MARK_LABEL: Record<keyof typeof MARKS, string> = { blind: "Tueur aveuglé", noscope: "Sans lunette", smoke: "À travers une fumée",
  wallbang: "À travers un mur", headshot: "Dans la tête" };

function Mark({ kind }: { kind: keyof typeof MARKS }) {
  return (
    <svg className={`r3-mark ${kind}`} viewBox="0 0 16 16" role="img" aria-label={MARK_LABEL[kind]}>
      <title>{MARK_LABEL[kind]}</title>
      <path d={MARKS[kind]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Skull() {
  return <svg className="r3-skull" viewBox="0 0 10 11" aria-hidden="true"><path d="M5 0a5 5 0 0 1 5 5c0 1.6-.8 2.6-1.8 3.2V11H1.8V8.2C.8 7.6 0 6.6 0 5a5 5 0 0 1 5-5zM3.2 6.3a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2zm3.6 0a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z" fill="currentColor" fillRule="evenodd" /></svg>;
}
function Person() {
  return <svg className="r3-person" viewBox="0 0 10 12" aria-hidden="true"><circle cx="5" cy="2.5" r="2.5" fill="currentColor" /><path d="M1 12V7.5A2.5 2.5 0 0 1 3.5 5h3A2.5 2.5 0 0 1 9 7.5V12z" fill="currentColor" /></svg>;
}
function Magazine() {
  return <svg className="r3-mag" viewBox="0 0 8 14" aria-hidden="true"><path d="M1.5 1h5l-.5 4 1.5 7.5L4 13 1 12.5 2 5z" fill="currentColor" /></svg>;
}
/** Armure du bandeau du bas, comme le jeu : bouclier dessiné au trait, le chiffre dedans, coiffé d'un casque si le joueur en
 *  a un ; sans armure, bouclier estompé. */
function ArmorBadge({ armor, helmet }: { armor: number; helmet: boolean }) {
  const shield = <path d="M23 12 41 18v11c0 9.5-7 15.5-18 19.5C12 44.5 5 38.5 5 29V18z" fill="rgb(0 0 0 / 0.25)" stroke="currentColor" strokeWidth="2.4" />;
  if (armor <= 0) return <svg viewBox="0 0 46 50" aria-hidden="true" opacity="0.45">{shield}</svg>;
  const label = helmet ? "Gilet et casque" : "Gilet seul";
  return (
    <svg viewBox="0 0 46 50" role="img" aria-label={label}>
      <title>{label}</title>
      {shield}
      {helmet && <path d="M10 10.5a13 9.5 0 0 1 26 0v1.8H10z" fill="currentColor" />}
    </svg>
  );
}

function PlayerCard({ p, me }: { p: BoardPlayer; me: boolean }) {
  return (
    <div className={`r3-card ${side(p.side)}${p.alive ? "" : " dead"}${me ? " me" : ""}`} data-sid={p.steamid} role="group"
      aria-label={p.alive ? p.name : `${p.name} mort`}>
      <span className="r3-card-name">{p.name}</span>
      <span className="r3-card-face"><Face /></span>
      {p.alive && (
        <span className={`r3-card-hp${p.hp <= 30 ? " low" : ""}`} role="img" aria-label={lifeLabel(p.hp)}>
          <i style={{ transform: `scaleX(${pct(p.hp)})` }} /><b>{p.hp}</b>
        </span>
      )}
      {p.kills > 0 && (
        <span className="r3-card-kills" role="img" aria-label={`${plural(p.kills, "kill")} dans ce round`}>
          {Array.from({ length: p.kills }, (_, i) => <Skull key={i} />)}
        </span>
      )}
      <span className="r3-card-money">{money(p.money)}</span>
      {p.alive && (<>
        <span className="r3-card-gun">{p.gun && <WeaponIcon name={p.gun} side={p.side} height={16} />}</span>
        <span className="r3-card-nades">{p.nades.map((n, i) => <NadeIcon key={i} kind={n} />)}</span>
        <span className="r3-card-gear">
          {p.armor > 0 && <ArmorIcon helmet={p.helmet} />}
          {p.bomb && <WeaponIcon name="C4 Explosive" height={14} className="hud-c4" title="Porte la bombe" />}
          {p.kit && <KitIcon />}
        </span>
      </>)}
    </div>
  );
}

/** Barre de score, en haut au centre, collée au haut de la vue (disposition du jeu, relevée) : au centre
 *  l'horloge du round (la bombe à sa place une fois posée, sans compte à rebours, comme le jeu), le score des deux camps
 *  (le point du vainqueur compté dès la fin du round) et les joueurs en vie ; de chaque côté les 5 joueurs du camp par
 *  emplacement (le numéro du radar), CT à gauche comme l'en-tête de la page. Sous l'horloge, l'étiquette « POV n » : numéro
 *  (1 à 10, dans l'ordre de la barre) du joueur suivi `me`, dont la carte est mise en évidence. */
export function Scoreboard({ board, me, ct, t }: { board: Board; me: string; ct: number; t: number }) {
  const { label, phase } = board.clock;
  const won = phase === "over" ? board.winner : null;
  const order = [...board.ct, ...board.t].findIndex((p) => p.steamid === me);
  const alive = (ps: BoardPlayer[]) => ps.filter((p) => p.alive).length;
  return (
    <div className="r3-board" data-testid="pov-board">
      <div className="r3-team ct">{board.ct.map((p) => <PlayerCard key={p.steamid} p={p} me={p.steamid === me} />)}</div>
      <div className="r3-mid">
        <div className={`r3-clock ${phase}`}>
          {phase === "planted"
            ? <WeaponIcon name="C4 Explosive" height={30} className="r3-clock-c4" title="Bombe posée" />
            : <span>{label}</span>}
        </div>
        <div className="r3-scores">
          <b className="r3-score ct">{ct + (won === "CT" ? 1 : 0)}</b><b className="r3-score t">{t + (won === "T" ? 1 : 0)}</b>
        </div>
        <div className="r3-alives">
          {(["ct", "t"] as const).map((s) => (
            <span key={s} className={`r3-alive ${s}`} role="img" aria-label={`${alive(board[s])} en vie`}><Person />{alive(board[s])}</span>
          ))}
        </div>
      </div>
      <div className="r3-team t">{board.t.map((p) => <PlayerCard key={p.steamid} p={p} me={p.steamid === me} />)}</div>
      {order >= 0 && <span className="r3-pov-label" data-testid="pov-label">POV {order + 1}</span>}
    </div>
  );
}

/** Fil des kills récents (6 s, 5 lignes : voir `povBoard`), en haut à droite (le plus récent en bas), comme le jeu : tueur
 *  (aveuglé : pictogramme avant son nom), passeur (« + », flash s'il l'a aveuglée), arme, sans lunette, à travers une
 *  fumée, à travers un mur, dans la tête, victime ; les kills du joueur suivi `me` sont cerclés de rouge. Mêmes icônes
 *  d'armes et mêmes noms que le fil des kills de la page. */
export function HudKillFeed({ kills, me }: { kills: BoardKill[]; me: string }) {
  return (
    <div className="r3-kills" data-testid="pov-killfeed">
      {kills.map((k) => (
        <div key={k.id} className={`r3-kill${k.attacker?.steamid === me ? " mine" : ""}`}>
          {k.blind && <Mark kind="blind" />}
          {k.attacker && <span className={`r3-kill-name ${side(k.attacker.side)}`}>{k.attacker.name}</span>}
          {k.assister && (<>
            <span className="r3-kill-plus">+</span>
            {k.flashAssist && <WeaponIcon name="Flashbang" height={20} className="r3-kill-flash" title="Passe décisive par flash" />}
            <span className={`r3-kill-name ${side(k.assister.side)}`}>{k.assister.name}</span>
          </>)}
          {weaponIconKey(k.weapon, k.attacker?.side)
            ? <WeaponIcon name={k.weapon} side={k.attacker?.side} height={22} className="r3-kill-gun" title={weaponLabel(k.weapon)} />
            : <span className="r3-kill-weapon">{weaponLabel(k.weapon)}</span>}
          {k.noscope && <Mark kind="noscope" />}
          {k.smoke && <Mark kind="smoke" />}
          {k.wallbang && <Mark kind="wallbang" />}
          {k.headshot && <Mark kind="headshot" />}
          <span className={`r3-kill-name ${side(k.victim.side)}`}>{k.victim.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Places de grenades du jeu : les vides sont des points. */
const NADE_PLACES = 4;
const pips = (n: number) => Array.from({ length: Math.max(0, NADE_PLACES - n) }, (_, i) => <i key={`p${i}`} className="r3-pip" />);

/** Un emplacement : ses armes (grenades : un point par place vide, à gauche, puis les grenades regroupées par type, « x2 »),
 *  le nom de celle en main, le numéro. */
function Slot({ s, sideOf }: { s: WeaponSlot; sideOf: Side }) {
  const held = s.items.find((it) => it.held);
  const groups: { name: string; count: number; held: boolean }[] = [];
  for (const it of s.items) {
    const g = groups.find((x) => x.name === it.name);
    if (g) { g.count++; g.held ||= it.held; } else groups.push({ name: it.name, count: 1, held: it.held });
  }
  return (
    <div className={`r3-slot${held ? " held" : ""}`} data-slot={s.n}>
      <span className="r3-slot-items">
        {s.n === 4 && pips(s.items.length)}
        {groups.map((g) => (
          <span key={g.name} className={`r3-slot-item${g.held ? " held" : ""}`}>
            <WeaponIcon name={g.name} side={sideOf} height={s.n === 4 ? 40 : s.n === 5 ? 36 : 38} />
            {g.count > 1 && <small>x{g.count}</small>}
          </span>
        ))}
      </span>
      {held && <span className="r3-slot-label">{held.name}</span>}
      <span className="r3-slot-n">{s.n}</span>
    </div>
  );
}

/** Armes du joueur suivi, à droite, comme le jeu (voir `weaponSlots`) : 1 principale, 2 pistolet, 3 couteau empilés ; en
 *  bas, sur une rangée, 5 (C4) puis 4 (grenades côte à côte, les places vides en points ; sans grenade, les 4 points seuls).
 *  Icônes tournées vers la gauche, teintées de la couleur du camp ; celle en main plus claire, avec son nom. */
export function WeaponSlots({ p }: { p: PlayerState }) {
  const slots = weaponSlots(p);
  const low = slots.filter((s) => s.n >= 4).sort((a, b) => b.n - a.n);
  return (
    <div className={`r3-slots ${side(p.side)}`} data-testid="pov-weapons">
      {slots.filter((s) => s.n <= 3).map((s) => <Slot key={s.n} s={s} sideOf={p.side} />)}
      <div className="r3-slots-low">
        {low.map((s) => <Slot key={s.n} s={s} sideOf={p.side} />)}
        {!low.some((s) => s.n === 4) && <div className="r3-slot r3-slot-pips"><span className="r3-slot-items">{pips(0)}</span></div>}
      </div>
    </div>
  );
}

/** Argent du joueur suivi, en bas à gauche. */
export function Money({ p }: { p: PlayerState }) {
  return <div className="r3-money" data-testid="pov-money">{money(p.money)}</div>;
}

/** Bas de l'écran, à gauche de l'arme : armure (bouclier, casque) et vie, avec la barre de vie ; dans le bandeau, le nom du
 *  joueur suivi (et son kit) et son ADR (`adrBefore` ; null : pas encore connu) ; au centre, son portrait. */
export function Vitals({ p, adr }: { p: PlayerState; adr: number | null }) {
  return (
    <div className={`r3-vitals ${side(p.side)}`} data-testid="pov-vitals">
      <span className="r3-armor">
        <ArmorBadge armor={p.armor} helmet={p.helmet} />
        <b role="img" aria-label={`${p.armor} d'armure`}>{p.armor}</b>
      </span>
      <span className={`r3-hp${p.hp <= 30 ? " low" : ""}`}>
        <b role="img" aria-label={lifeLabel(p.hp)}>{p.hp}</b>
        <span className="r3-hp-bar"><i style={{ transform: `scaleX(${pct(p.hp)})` }} /></span>
      </span>
      <span className="r3-who">
        <span className="r3-who-name">{p.name}{p.defuser && <KitIcon />}</span>
        <span className="r3-adr">ADR<b>{adr ?? "—"}</b></span>
      </span>
      <span className="r3-avatar"><Face /></span>
    </div>
  );
}

/** Bas de l'écran, à droite : nom de l'arme en main (la ligne du skin reste vide : pas de données de skins avant la vague 3),
 *  puis ses munitions — armes à feu (et zeus) seulement — : chargeur, avec sa barre, et réserve si elle est connue et non
 *  nulle ; chargeur vide en rouge. Sans arme connue : rien. */
export function Ammo({ p }: { p: PlayerState }) {
  if (!p.weapon) return null;
  const cls = weaponClass(p.weapon);
  const clip = cls !== null && FIREARMS.has(cls) ? p.clip : null;
  const reserve = p.reserve !== null && p.reserve > 0 ? p.reserve : null;
  const fill = clip === null ? 0 : MAG[p.weapon] ? Math.min(1, clip / MAG[p.weapon]) : clip > 0 ? 1 : 0;
  return (
    <div className="r3-ammo" data-testid="pov-ammo">
      <span className="r3-weapon"><span className="r3-weapon-name">{p.weapon}</span><span className="r3-skin"></span></span>
      {clip !== null && (
        <span className="r3-ammo-count" role="img"
          aria-label={`${plural(clip, "balle")} dans le chargeur${reserve !== null ? `, ${plural(reserve, "chargeur")} de réserve` : ""}`}>
          <b className={`r3-ammo-n${clip === 0 ? " empty" : ""}`}>{clip}<i className="r3-clip-bar" style={{ transform: `scaleX(${fill})` }} /></b>
          {reserve !== null && <span className="r3-reserve">{reserve}<Magazine /></span>}
        </span>
      )}
    </div>
  );
}

/** Bandeau de fin de round, sous la barre de score : le camp vainqueur. */
export function WinBanner({ side: s }: { side: Side }) {
  return (
    <div className={`r3-win ${side(s)}`} data-testid="pov-win">
      <span>{s === "T" ? "Les terroristes gagnent" : "Les antiterroristes gagnent"}</span>
    </div>
  );
}

/** HUD complet de la vue du joueur, disposé comme celui du jeu : dégradé sombre en bas de la vue,
 *  radar collé en haut à gauche, barre de score collée en haut au centre, fil des kills en haut à droite, armes à droite,
 *  argent en bas à gauche, bandeau du joueur en bas au centre (vie, armure, nom, ADR, portrait, arme, munitions), bandeau de
 *  fin de round. `board` : null tant que la vue ne l'a pas encore calculé (première image) ; `radar` : null si la page n'a
 *  pas la carte du radar 2D ; `adr` : celui du joueur suivi, null s'il n'est pas encore connu. */
export function PovHud({ p, board, ct, t, radar, adr }: {
  p: PlayerState; board: Board | null; ct: number; t: number; radar: RadarSource | null; adr: number | null;
}) {
  return (
    <div className={`r3-cs ${side(p.side)}`} data-testid="pov-hud">
      <div className="r3-shade" data-testid="pov-shade" />
      {radar && <MiniRadar radar={radar} sid={p.steamid} />}
      {board && <Scoreboard board={board} me={p.steamid} ct={ct} t={t} />}
      {board && <HudKillFeed kills={board.kills} me={p.steamid} />}
      <WeaponSlots p={p} />
      <Money p={p} />
      <div className="r3-bottom">
        <Vitals p={p} adr={adr} />
        <Ammo p={p} />
      </div>
      {board?.winner && <WinBanner side={board.winner} />}
    </div>
  );
}

export interface PovLayerProps {
  mode: CameraMode; followed: PlayerState | null; board: Board | null;
  /** score des camps avant ce round */
  ct: number; t: number;
  windowHeight: number; radar: RadarSource | null;
  /** ADR de chaque joueur (`adrBefore`) ; null : pas encore connu (rounds précédents en cours de chargement) */
  adr: ReadonlyMap<string, number> | null;
  /** ref du voile des flashs (stable : `veilWriter().ref`), qui y écrit l'opacité sans rendu React */
  veilRef?: (el: HTMLDivElement | null) => void;
}

/** Calque de la vue du joueur, par-dessus le canvas, en caméra « Joueur » seulement : lunette, réticule, HUD (et son
 *  dégradé sombre), puis le voile blanc des flashs, en dernier (voile au-dessus du HUD) : un flash
 *  blanchit tout uniformément, HUD compris. Son opacité est la variable CSS `--r3-flash` posée sur le voile lui-même par
 *  `Scene3D` à chaque changement (`Viewer.onFlash`, `veilWriter`) : le voile change à chaque image d'un fondu, sans rendu
 *  React ni restyle du HUD. Aucun clic n'est pris (`.r3-pov`). Mémoïsé : la page rend la vue 3D à chaque image, ce calque
 *  seulement quand ses données changent (`onFollow`, `onBoard`, caméra, fenêtre, ADR). */
export const PovLayer = memo(function PovLayer({ mode, followed, board, ct, t, windowHeight, radar, adr, veilRef }: PovLayerProps) {
  if (mode !== "pov" || !followed) return null;
  const scope = scopeKind(followed.weapon, followed.scoped);
  return (
    <div className="r3-pov" data-testid="pov-layer">
      {scope && <ScopeOverlay kind={scope} />}
      {crosshairShown(followed, scope) && <CrosshairView code={followed.crosshair} windowHeight={windowHeight} />}
      <PovHud p={followed} board={board} ct={ct} t={t} radar={radar} adr={adr ? adr.get(followed.steamid) ?? 0 : null} />
      <div ref={veilRef} className="r3-veil" data-testid="pov-flash" aria-hidden="true"></div>
    </div>
  );
});
