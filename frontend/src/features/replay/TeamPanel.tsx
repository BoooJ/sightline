import type { Side } from "../../shared/api/types";
import { formatMoney } from "../../shared/format";
import type { PlayerState } from "./engine/state";
import { ArmorIcon, BombIcon, KitIcon, NadeIcon, nadeKind, shortWeapon, sortInventory, weaponClass, WeaponIcon } from "./hud";

/** Panneau d'équipe : par joueur, PV (chiffre + barre), argent, armure et kit, arme principale et pistolet
 *  (l'arme en main en évidence), grenades en pictogrammes. */
export function TeamPanel({ side, name, score, players, selected, onSelect }: {
  side: Side; name: string; score: number; players: PlayerState[]; selected: string | null; onSelect: (sid: string) => void;
}) {
  const cls = side.toLowerCase();
  return (
    <section className={`team-panel ${cls}`} data-testid={`team-${cls}`}>
      <header><span className="tp-name display">{name}</span><span className="tp-score display">{score}</span></header>
      {[...players].sort((a, b) => a.slot - b.slot).map((p) => {
        const inv = sortInventory(p.inventory);
        const held = p.weapon;
        const heldClass = weaponClass(held);
        // arme tenue qui n'est ni la principale, ni le pistolet, ni une grenade, ni le C4 : couteau ou zeus
        const heldNade = nadeKind(held);
        const other = held && held !== inv.primary && held !== inv.pistol && !heldNade && held !== "C4 Explosive" ? held : null;
        // grenade en main : la première du même type est mise en évidence (ajoutée si l'inventaire ne la contient pas)
        const nades = heldNade && !inv.nades.includes(heldNade) ? [heldNade, ...inv.nades] : inv.nades;
        const heldIdx = heldNade ? nades.indexOf(heldNade) : -1;
        const low = p.alive && p.hp <= 30;
        return (
          <button key={p.steamid} type="button" className={`tp-row ${p.alive ? "" : "dead"} ${selected === p.steamid ? "sel" : ""}`}
            onClick={() => onSelect(p.steamid)} data-testid="tp-row">
            <span className="tp-line1">
              <span className="tp-slot mono">{p.slot}</span>
              <span className="tp-pname">{p.name}</span>
              <span className="tp-money mono">{formatMoney(p.money)}</span>
            </span>
            {p.alive ? (<>
              <span className="tp-line2">
                <b className={`tp-hpnum mono ${low ? "low" : ""}`} aria-label={`${p.hp} points de vie`}>{p.hp}</b>
                <span className="tp-hpbar"><span className={low ? "low" : ""} style={{ transform: `scaleX(${Math.max(0, Math.min(100, p.hp)) / 100})` }} /></span>
                <span className="tp-gear">
                  {p.armor > 0 && <ArmorIcon helmet={p.helmet} />}
                  {p.defuser && <KitIcon />}
                  {p.hasBomb && <BombIcon />}
                </span>
              </span>
              <span className="tp-line3">
                {inv.primary && <span className={`tp-gun ${held === inv.primary ? "held" : ""}`} title={inv.primary}>
                  <WeaponIcon name={inv.primary} height={15} /><span>{shortWeapon(inv.primary)}</span></span>}
                {inv.pistol && <span className={`tp-gun tp-pistol ${held === inv.pistol ? "held" : ""}`} title={inv.pistol}>
                  <WeaponIcon name={inv.pistol} height={14} /></span>}
                {other && (heldClass === "knife" || heldClass === "zeus"
                  ? <span className="tp-gun held" title={heldClass === "knife" ? "Couteau en main" : "Zeus en main"}><WeaponIcon name={other} side={side} height={13} /></span>
                  : <span className="tp-gun held" title={other}><span>{shortWeapon(other)}</span></span>)}
                <span className="tp-nades">{nades.map((n, i) => <NadeIcon key={i} kind={n} held={i === heldIdx} />)}</span>
              </span>
            </>) : <span className="tp-deadline">Mort</span>}
          </button>
        );
      })}
    </section>
  );
}
