import type { KillEvent } from "../../shared/api/types";
import type { Replay } from "./engine/replay";
import { recentKills } from "./engine/state";
import { weaponLabel } from "../../shared/format";
import type { PlaceLabel } from "../../shared/callouts";
import { weaponIconKey, WeaponIcon } from "./hud";

/** Particularités d'un kill, en abrégé : tête (HS), à travers un mur (WB), une fumée (SMK), sans lunette (NS), tueur
 *  aveuglé (FL). Aussi utilisé par le fil des kills de la vue du joueur (3D). */
export const killTags = (k: KillEvent): string[] =>
  [k.headshot && "HS", k.penetrated > 0 && "WB", k.through_smoke && "SMK", k.noscope && "NS", k.attacker_blind && "FL"]
    .filter((t): t is string => !!t);

export function KillFeed({ replay, tick, onJump, swings, place }: {
  replay: Replay; tick: number; onJump: (t: number) => void;
  /** variation de probabilité de victoire du camp du tueur, par « tick-victime » */
  swings?: Map<string, number>; place?: PlaceLabel;
}) {
  const info = new Map(replay.payload.players.map((p) => [p.steamid, p]));
  const kills = recentKills(replay, tick, 5 * replay.tickrate).slice(-6);
  return (
    <div className="killfeed" data-testid="killfeed">
      {kills.map((k) => {
        const a = k.attacker ? info.get(k.attacker) : undefined, v = info.get(k.victim);
        const tags = killTags(k);
        return (
          <button key={`${k.tick}-${k.victim}`} type="button" className={`kf-row ${k.is_opening ? "opening" : ""}`}
            onClick={() => onJump(k.tick - 2 * replay.tickrate)}>
            {a && <span className={`kf-name ${a.side.toLowerCase()}`}>{a.name}</span>}
            {weaponIconKey(k.weapon, a?.side) ? <WeaponIcon name={k.weapon} side={a?.side} height={14} className="kf-wicon" title={weaponLabel(k.weapon)} />
              : <span className="kf-weapon">{weaponLabel(k.weapon)}</span>}
            {tags.map((t) => <span key={t} className="kf-tag">{t}</span>)}
            <span className={`kf-name ${(v?.side ?? "T").toLowerCase()}`}>{v?.name ?? k.victim}</span>
            {place && place(k.victim_place, k.victim_pos) && <span className="kf-place">{place(k.victim_place, k.victim_pos)}</span>}
            {swings?.has(`${k.tick}-${k.victim}`) && <span className="kf-swing mono" title="Probabilité de victoire gagnée par le camp du tueur">+{Math.round(swings.get(`${k.tick}-${k.victim}`)! * 100)}%</span>}
          </button>
        );
      })}
    </div>
  );
}
