import type { ReactNode } from "react";
import type { DefaultKind, EngageSite, Stat } from "../../shared/api/types";
import { clockHint, gameClock } from "../../shared/roundTime";
import { DEFAULT_KIND_LABEL, engageParts, shownKinds } from "./defaultPhases";

export { DEFAULT_KINDS, DEFAULT_KIND_LABEL } from "./defaultPhases";

/** Petits éléments communs du scouting : comptages « k sur n », pastilles de fiabilité, termes expliqués. */

export type Mode = "simple" | "advanced";

export const LEVEL: Record<Stat["level"], { dots: number; label: string; help: string }> = {
  none: { dots: 0, label: "aucune donnée", help: "Pas encore de round pour ce chiffre." },
  anecdotal: { dots: 1, label: "à confirmer", help: "Très peu de rounds : un seul round de plus peut tout changer. À prendre comme une piste." },
  indicative: { dots: 2, label: "tendance", help: "Assez de rounds pour voir une tendance, pas assez pour une certitude." },
  solid: { dots: 3, label: "fiable", help: "Assez de rounds pour s'y fier." },
};

export const GLOSSARY: Record<string, string> = {
  pistol: "Premier round de chaque mi-temps (round 1 et 13) : tout le monde n'a qu'un pistolet.",
  eco: "Round où l'équipe n'achète presque rien pour économiser (équipement d'équipe sous 5 000 $ ; semi 5 000–10 000 $, force 10 000–20 000 $, full au-delà).",
  force: "Achat forcé : l'équipe achète avec peu d'argent au lieu d'économiser, souvent juste après un pistol perdu.",
  plantbonus: "Pistol T perdu mais bombe posée : chaque T touche 800 $ de plus en plus des 1 400 $ de défaite (environ 2 200 à 2 500 $ chacun), assez pour forcer au round 2. Sans pose, l'éco est presque obligatoire.",
  gun: "Premier round de la mi-temps où l'équipe achète des armes complètes (fusils et protections).",
  default: "Les T prennent le contrôle de la carte avant de choisir un site : premier contact tardif, équipe dispersée au contact, ou contact rapide mais prise du site après 50 s de jeu (1:05 à l'horloge). Quatre fins : puis exécution, puis prise, aux duels, sans prise.",
  rush: "Les T foncent à plusieurs sur un site très tôt : premier contact dans les 22 premières secondes (avant 1:33 à l'horloge) et au moins 3 T sur le site. Si la prise du site n'arrive qu'après 50 s de jeu (1:05), le round compte comme un default.",
  execute: "Prise de site coordonnée : au moins 3 T sur le site avec au moins 4 grenades lancées avant le contact (smokes, flashs, molotovs).",
  engage: "Prise du site : le premier de ces moments — au moins 3 T vivants restent 1 s sur le site A ou B (après 5 s de jeu), la bombe est posée, ou un T est tué sur le site avec un coéquipier vivant à côté. C'est l'heure où l'attaque frappe vraiment, souvent bien après le premier contact.",
  default_exec: "Default qui finit par une exécution : au moins 3 grenades des T lancées entre 15 s avant la prise du site et 3 s après, qui éclatent sur le site pris. La pose n'est pas exigée.",
  default_take: "Default qui finit par une prise du site avec peu de grenades (moins de 3 sur le site autour de la prise) : une entrée sans exécution préparée.",
  default_duels: "Default sans prise du site : le round se joue en duels sur la carte et se termine par l'élimination d'une des deux équipes. Dans la bibliothèque, les T n'en gagnent que trois sur dix.",
  default_no_take: "Default sans prise du site ni pose, jusqu'à la fin du temps.",
  ctrot: "À la première pression des T sur un site avant la pose (2 grenades en 5 s, ou 2 T pendant 1 s près du site), un CT qui tenait l'autre site le quitte et arrive près du site pressé dans les 15 s. Non mesurée quand les sites A et B sont trop proches (sur Nuke, ils sont l'un au-dessus de l'autre).",
  split: "Prise de site par deux chemins à la fois (ex. un groupe par Mid, un par Long), pour diviser l'attention des CT.",
  fake: "Grenades et bruit sur un site pour attirer les rotations, puis bombe posée sur l'autre site.",
  setup: "Comment les CT se répartissent 20 s après le début du round. « A3 · B2 » : 3 joueurs vers A, 2 vers B.",
  trade: "Reprendre tout de suite un coéquipier tué : on tue son tueur dans les 5 secondes (même fenêtre que HLTV).",
  entry: "Le joueur qui ouvre les duels, souvent le premier à entrer sur un site.",
  awp: "Le fusil de précision (sniper). Un seul joueur le joue en général.",
  rating: "Rating 2.0 approchée (KAST, kills, morts, impact, ADR) : 1,00 est la moyenne, au-dessus de 1,10 c'est très bon. La Rating 3.0 de HLTV ajoute un ajustement à l'économie, non reproduit ici.",
  adr: "Dégâts moyens infligés par round.",
  kast: "Part des rounds où le joueur fait un kill, une assistance, survit ou est vengé (trade).",
  ouverture: "Premier duel du round : celui qui le gagne donne souvent l'avantage à son équipe.",
  implication: "Part des rounds de l'équipe où ce joueur est dans le premier duel (qu'il le gagne ou le perde). Beaucoup de premiers duels avec peu de réussite : une faille à exploiter.",
  biblio: "Part moyenne de ce style chez les autres équipes de votre bibliothèque sur cette carte : un écart net signale une équipe prévisible.",
};

export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children: ReactNode }) {
  return <abbr className="ts-term" title={GLOSSARY[k] ?? ""}>{children}</abbr>;
}

export function Dots({ s }: { s: Stat }) {
  const l = LEVEL[s.level];
  return (
    <span className={`ts-dots l${l.dots}`} title={`${l.label} — ${l.help} (${s.n} round${s.n > 1 ? "s" : ""})`} aria-label={`Fiabilité : ${l.label}`}>
      {[0, 1, 2].map((i) => <i key={i} className={i < l.dots ? "on" : ""} />)}
    </span>
  );
}

/** « 7 sur 9 (78 %) » + pastilles ; vert/rouge seulement quand l'écart avec 50 % est net. */
export function Count({ s, mode, of = "sur" }: { s: Stat; mode: Mode; of?: string }) {
  if (!s.n) return <span className="ts-count none">aucune donnée</span>;
  return (
    <span className={`ts-count ${s.tone}`}>
      <b>{s.k}</b> {s.k > 1 ? of : of.replace(/^rounds\b/, "round")} {s.n} <small>({s.pct} %)</small>
      {mode === "advanced" && <small className="ts-ci" title="Fourchette probable (90 %) compte tenu du peu de rounds">{s.lo}–{s.hi} %</small>}
      <Dots s={s} />
    </span>
  );
}

/** Fins du default : « puis prise 5 (4 gagnés) · aux duels 3 (0 gagné) », dans l'ordre fixe, sans les comptes nuls. */
export function DefaultKinds({ kinds }: { kinds?: { key: DefaultKind; label: string; count: Stat; won: Stat }[] | null }) {
  const list = shownKinds(kinds);
  if (!list.length) return null;
  return (
    <span className="ts-kinds" data-testid="ts-default-kinds">
      {list.map(({ key, count, won }) => (
        <span key={key}><Term k={`default_${key}`}>{DEFAULT_KIND_LABEL[key]}</Term> <b className="mono">{count.k}</b> <small className={won.tone}>(<span className="mono">{won.k}</span> gagné{won.k > 1 ? "s" : ""})</small></span>
      ))}
    </span>
  );
}

/** « · prise du site A vers 0:57, B vers 1:02 » (horloge du jeu) ; rien pour les anciens rapports. `first` : premier
 *  élément de la phrase (pas de « · » devant, majuscule). */
export function EngageSites({ e, first = false }: { e?: { A?: EngageSite; B?: EngageSite } | null; first?: boolean }) {
  const parts = engageParts(e);
  if (!parts.length) return null;
  return (
    <span data-testid="ts-engage">{first ? "" : " · "}<Term k="engage">{first ? "Prise du site" : "prise du site"}</Term> {parts.map((p, i) => (
      <span key={p.site}>{i > 0 && ", "}{p.site} vers <b className="mono" title={clockHint(p.median_s)}>{gameClock(p.median_s)}</b></span>
    ))}</span>
  );
}

