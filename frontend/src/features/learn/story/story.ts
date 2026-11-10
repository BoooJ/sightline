import type { StoryRound, StoryStep, StoryUtility, Vec3 } from "../../../shared/api/types";
import { weaponLabel } from "../../../shared/format";

/** Nom lisible d'un lieu (callout placé à la main ou lieu du jeu). */
export type PlaceName = (place: string | null | undefined, pos?: Vec3 | null) => string | null;

/** Texte d'une étape : `title` court (en tête de carte), `text` = la phrase, avec les lieux et joueurs entre ** **. */
export interface StepText { title: string; text: string }

const SHORT: Record<string, string> = {
  "Kevlar & Helmet": "Kevlar + casque", "Kevlar Vest": "Kevlar", "Defuse Kit": "Kit de désamorçage", "Smoke Grenade": "Smoke",
  "Flashbang": "Flash", "High Explosive Grenade": "HE", "Incendiary Grenade": "Incendiaire", "Decoy Grenade": "Leurre",
  "Dual Berettas": "Dualies", "Desert Eagle": "Deagle", "R8 Revolver": "R8", "Galil AR": "Galil",
};

/** « AK-47, Kevlar + casque, Flash ×2 » : achats regroupés (un joueur achète souvent pour ses coéquipiers). */
export function buyList(items: string[]): string {
  const n = new Map<string, number>();
  for (const it of items) n.set(SHORT[it] ?? it, (n.get(SHORT[it] ?? it) ?? 0) + 1);
  return [...n].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)).join(", ");
}

/** Durées d'un round compétitif CS2 : 1:55 de jeu après le freeze time, 40 s une fois la bombe posée. */
export const ROUND_S = 115;
export const BOMB_S = 40;

/** Horloge affichée en jeu à `t` secondes après le freeze time : le temps du round qui descend, ou le compte à
 *  rebours de la bombe une fois posée. */
export function roundClock(t: number, plantT: number | null): { text: string; bomb: boolean } {
  if (plantT !== null && t >= plantT) return { text: fmtT(Math.ceil(BOMB_S - (t - plantT))), bomb: true };
  return { text: fmtT(Math.ceil(ROUND_S - t)), bomb: false };
}

export const fmtT = (t: number) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, "0")}`;

const NADE_NAME: Record<string, string> = {
  smoke: "une smoke", flash: "une flash", he: "une HE", molotov: "un molotov", incendiary: "une incendiaire", decoy: "un leurre",
};

export function stepText(s: StoryStep, name: PlaceName): StepText {
  const at = (place: string | null | undefined, pos?: Vec3 | null) => name(place, pos);
  const where = at(s.place, s.pos);
  switch (s.kind) {
    case "buy":
      return { title: "Achat", text: (s.items?.length ? `Achète ${buyList(s.items)}` : "N'achète rien : garde son équipement")
        + (s.weapon ? ` · joue avec **${s.weapon}**` : "") };
    case "place":
      return s.first
        ? { title: "Son poste", text: `Se place à **${where ?? "?"}**` }
        : { title: "Rotation", text: `Se déplace vers **${where ?? "?"}**` };
    case "nade": {
      const to = at(s.target_place, s.target);
      return { title: "Utilitaire", text: `Lance ${NADE_NAME[s.nade ?? ""] ?? "une grenade"}${to ? ` vers **${to}**` : ""}${where && where !== to ? ` depuis ${where}` : ""}` };
    }
    case "kill":
      if (s.teamkill) return { title: "Erreur", text: `Tue son coéquipier **${s.victim}**` };
      return {
        title: s.opening ? "Premier kill du round" : "Kill",
        text: `Élimine **${s.victim}** à ${weaponLabel(s.weapon ?? "")}${s.headshot ? " (headshot)" : ""}${where ? ` depuis **${where}**` : ""}`,
      };
    case "plant":
      return { title: "Bombe", text: `Pose la bombe${s.site ? ` sur le site **${s.site}**` : ""}` };
    case "defuse":
      return { title: "Bombe", text: "Désamorce la bombe" };
    case "death":
      return {
        title: "Mort",
        text: s.attacker
          ? `Meurt contre **${s.attacker}** (${weaponLabel(s.weapon ?? "")}${s.headshot ? ", headshot" : ""})${where ? ` à **${where}**` : ""}`
          : `Meurt${where ? ` à **${where}**` : ""}`,
      };
    case "end":
      return {
        title: s.won ? "Round gagné" : s.won === false ? "Round perdu" : "Fin du round",
        text: s.won ? (s.alive ? "Son équipe gagne le round, et il survit." : "Son équipe gagne le round.")
          : s.won === false ? (s.alive ? "Son équipe perd le round ; il survit (sauvegarde ou fin du temps)." : "Son équipe perd le round.")
          : "Fin du round.",
      };
  }
}

/** Round conseillé pour commencer : gagné, avec des kills, en restant en vie le plus longtemps possible. */
/** Types d'achat en clair ; « armé » = achat complet (fusils et protections). */
export const BUY_LABEL: Record<string, string> = { pistol: "Pistol", eco: "Eco", semi: "Semi", force: "Force", full: "Armé" };
export const isArmed = (r: StoryRound) => r.buy === "full";

/** Round conseillé pour commencer : un round armé typique de sa routine (joué à son poste le plus fréquent), gagné,
 *  avec des actions ; sans round armé, le meilleur round disponible. */
export function bestRound(rounds: StoryRound[]): StoryRound | undefined {
  const armed = rounds.filter(isArmed);
  const pool = armed.length ? armed : rounds;
  const postes = new Map<string, number>();
  for (const r of pool) if (r.poste) postes.set(r.poste, (postes.get(r.poste) ?? 0) + 1);
  const usual = [...postes].sort((a, b) => b[1] - a[1])[0]?.[0];
  const score = (r: StoryRound) => (r.won ? 100 : 0) + (usual && r.poste === usual ? 60 : 0) + 15 * Math.min(r.kills, 3) + (r.died ? 0 : 20) + Math.min(r.steps.length, 8);
  return [...pool].sort((a, b) => score(b) - score(a) || a.number - b.number)[0];
}

/** Trajet jusqu'à l'instant `t` (secondes après le freeze time). */
export function pathUntil(r: StoryRound, t: number): Vec3[] {
  return r.path.filter((p) => p[0] <= t + 0.01).map((p) => [p[1], p[2], p[3]] as Vec3);
}

/** Les étapes qu'on montre sur la carte (avec une position) ; l'achat n'est pas un lieu. */
export const onMap = (s: StoryStep) => !!s.pos && s.kind !== "buy";

/** Unités du jeu -> mètres (1 unité ≈ 1,9 cm). */
export const toMeters = (u: number) => Math.round(u * 0.019);

export const UTILITY_NAME: Record<string, string> = {
  smoke: "smoke", flash: "flash", he: "HE", molotov: "molotov", incendiary: "incendiaire", decoy: "leurre",
};

/** Situation autour du joueur à l'instant d'une étape : rapport de force, coéquipier le plus proche, utilitaire ennemi. */
export interface Situation {
  mates: number; enemies: number; nearest: { name: string; meters: number } | null;
  utility: { type: StoryUtility["type"]; label: string; flying: boolean; where: string | null; thrower: string }[];
}

export function situation(s: StoryStep, placeAt: (pos: Vec3 | null) => string | null): Situation {
  let nearest: Situation["nearest"] = null;
  if (s.pos) {
    for (const m of s.mates) {
      const d = toMeters(Math.hypot(m.pos[0] - s.pos[0], m.pos[1] - s.pos[1]));
      if (!nearest || d < nearest.meters) nearest = { name: m.name, meters: d };
    }
  }
  const alive = s.kind === "death" ? 0 : 1;  // le joueur lui-même
  return {
    mates: s.mates.length + alive, enemies: s.enemies.length, nearest,
    utility: s.enemy_utility.map((u) => ({ type: u.type, label: UTILITY_NAME[u.type] ?? u.type, flying: u.flying,
      where: u.flying ? null : placeAt(u.pos), thrower: u.thrower })),
  };
}

