import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { MapMeta, ReplayPayload } from "../../shared/api/types";
import { usePlaceAt } from "../../shared/callouts";
import type { Replay } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import { readTheme } from "../replay/renderer/theme";
import { freshUrl } from "./api";
import { useAssets3d, vmLoader } from "./assets";
import { adrBefore, type Board } from "./board";
import { collisionFromScene } from "./collision";
import { veilWriter } from "./flash";
import { fetchGlb, LoadError, parseGlb } from "./loader";
import type { RadarFrame, RadarSource } from "./MiniRadar";
import { hudScale, PovLayer } from "./PovHud";
import type { CameraMode, Map3d, Variant } from "./types";
import { Viewer } from "./viewer";
import "./replay3d.css";

export interface Scene3DProps {
  replay: Replay; map3d: Map3d; variant: Variant; onVariant: (v: Variant) => void; tick: number;
  selected: string | null; onSelect: (sid: string | null) => void; onFail: (reason: string) => void;
  /** carte du radar 2D (petit radar du HUD de la vue du joueur) ; null : pas de radar dans le HUD */
  radar: MapMeta | null;
  /** score des camps avant ce round (barre de score du HUD de la vue du joueur) */
  score: { ct: number; t: number };
  /** vue affichée ; faux : replay repassé en 2D, vue cachée et en pause, gardée pour le retour (`LazyScene3D`) */
  active: boolean;
}

const MODES: { id: CameraMode; label: string; title: string }[] = [
  { id: "free", label: "Libre", title: "Clic droit maintenu + ZQSD (WASD) et souris ; Maj : plus vite ; E / A (Q en QWERTY) : monter, descendre" },
  { id: "follow", label: "Suivi", title: "Orbite autour du joueur choisi (glisser pour tourner, molette pour la distance)" },
  { id: "pov", label: "Joueur", title: "Vue du joueur choisi : son regard, son réticule, sa lunette et son HUD" },
  { id: "top", label: "Dessus", title: "Vue du dessus (glisser pour déplacer, molette pour zoomer)" },
  { id: "tv", label: "TV", title: "Suit l'action : le joueur qui fera le prochain kill" },
];
const mb = (n: number) => (n / 1024 / 1024).toFixed(0);

/** Relire la liste des fichiers « vue » après l'échec de l'un d'eux (`Viewer.onVmError`) ? Seulement s'il est introuvable
 *  (404) : un fichier ré-exporté a changé d'adresse (le nom suit le contenu, l'ancien est supprimé). Pas pour les autres
 *  échecs : la liste relue donnerait la même adresse, et la relecture se referait à chaque nouvel essai du ViewModel (toutes
 *  les 10 s, sans fin) ; le ViewModel réessaie seul (fichier illisible, réseau coupé, 5xx). Ni pour une session expirée
 *  (401) : la liste relue répondrait 401 elle aussi et `fetchAssets3d` ouvrirait l'écran de connexion. La vue du joueur
 *  reste alors sans bras. */
export const shouldRefreshAssets = (err: unknown): boolean => err instanceof LoadError && err.status === 404;

/** Hauteur de la fenêtre du navigateur en pixels CSS : le réticule se cale sur elle, et non sur la vue 3D. */
function useWindowHeight(): number {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}

type Adr = ReadonlyMap<string, number> | null;

/** ADR de chaque joueur au round `round` du match `matchId` (`adrBefore`), d'après les replays des rounds précédents. Ils
 *  sont dans le cache de react-query : la page de replay précharge tout le match (rounds voisins d'abord). Ces requêtes ne
 *  font que regarder le cache (`enabled: false`) : rien de plus n'est téléchargé ; tant qu'il manque un round, l'ADR est
 *  inconnu (null). Composant à part et mémoïsé : la vue 3D se rend à chaque image de la lecture, lui seulement quand le
 *  round change ou qu'un round précédent arrive dans le cache ; il passe la table par `onAdr`. */
const AdrWatch = memo(function AdrWatch({ matchId, round, onAdr }: { matchId: number; round: number; onAdr: (a: Adr) => void }) {
  const match = useQuery({ queryKey: ["match", matchId], queryFn: () => api.match(matchId), enabled: false });
  const known = match.data !== undefined;
  // `combine` stable : le tableau des replays ne change que si l'un d'eux change (pas à chaque rendu)
  const payloads = useQueries({ queries: (match.data?.rounds ?? []).filter((x) => x.number < round)
    .map((x) => ({ queryKey: ["replay", x.id], queryFn: () => api.replay(x.id), enabled: false, staleTime: Infinity })), combine: payloadsOf });
  const adr = useMemo(() => (known ? adrBefore(payloads, round) : null), [known, payloads, round]);
  useEffect(() => onAdr(adr), [adr, onAdr]);
  return null;
});
const payloadsOf = (rs: UseQueryResult<ReplayPayload>[]) => rs.map((r) => r.data);

/** En caméra « Joueur » (souris seulement), marque la vue quand la souris approche de la barre des caméras ou de la bande des
 *  tactiques de la page (`data-near-bar`, `data-near-strip`, à `NEAR_PX` près) : transparentes et sans clics le reste du
 *  temps (replay3d.css), elles réapparaissent alors. Les mouvements sont lus sur le conteneur de la vue (la bande en est
 *  une sœur), sans rendu React. */
const NEAR_PX = 24;
function useRevealNear(wrap: { readonly current: HTMLDivElement | null }, on: boolean) {
  useEffect(() => {
    const w = wrap.current, host = w?.parentElement;
    if (!on || !w || !host) return;
    const near = (el: Element | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - NEAR_PX && x <= r.right + NEAR_PX && y >= r.top - NEAR_PX && y <= r.bottom + NEAR_PX;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      w.toggleAttribute("data-near-bar", near(w.querySelector(".r3-bar"), e.clientX, e.clientY));
      w.toggleAttribute("data-near-strip", near(host.querySelector(".rp-strip"), e.clientX, e.clientY));
    };
    const leave = () => { w.removeAttribute("data-near-bar"); w.removeAttribute("data-near-strip"); };
    // on entre en caméra « Joueur » par un bouton de la barre : la souris y est encore, la barre reste jusqu'au prochain mouvement
    w.setAttribute("data-near-bar", "");
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      leave();
    };
  }, [wrap, on]);
}

/** Vue 3D du replay, à la place du radar ; chargée à la demande (three.js n'est pas dans le paquet principal). */
export default function Scene3D(p: Scene3DProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const fail = useRef(p.onFail);
  fail.current = p.onFail;
  // celle du dernier rendu, comme `fail` : le chargement de la carte continue pendant la 2D, et la fonction du rendu où il
  // a commencé (3D affichée) n'est plus la bonne
  const onVariant = useRef(p.onVariant);
  onVariant.current = p.onVariant;
  const qc = useQueryClient();
  const relisted = useRef(false);  // liste des cartes déjà relue après un fichier en 404 (une seule fois)
  // carte à relire : contexte graphique rendu alors que des images de ses textures avaient été libérées après leur envoi
  // (`Viewer.onMapLost`) ; relue comme au premier affichage, depuis sa copie gardée dans le navigateur
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<CameraMode>("follow");
  // HUD de la vue du joueur. La page rend cette vue à chaque image de la lecture ; le calque du HUD (`PovLayer`,
  // mémoïsé) ne l'est que quand l'un de ces états change : joueur suivi quand ce qu'en montre le HUD change (voir
  // `followKey`), tableau (horloge à la seconde, 10 joueurs, kills : voir `boardKey`) au plus une fois par instant ; le
  // petit radar lit l'instant dans `frame` à sa propre cadence (`RADAR_HZ`), sans rendu React.
  const [followed, setFollowed] = useState<PlayerState | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const frame = useRef<RadarFrame | null>(null);
  const veil = useMemo(veilWriter, []);  // voile blanc des flashs : opacité écrite sur lui seul, sans rendu React
  const placeAt = usePlaceAt(p.replay.payload.map_name);
  const radar = useMemo<RadarSource | null>(() => (p.radar ? { map: p.radar, frame, placeAt } : null), [p.radar, placeAt]);
  const windowHeight = useWindowHeight();  // réticule
  const [adr, setAdr] = useState<Adr>(null);
  useRevealNear(wrap, mode === "pov" && p.active);
  // what : ce qui se charge ; mini : une carte est déjà affichée, seules les textures arrivent (encart discret, caméras
  // utilisables)
  const [load, setLoad] = useState<{ got: number; total: number; what: string; mini: boolean } | null>(null);
  const entry = p.map3d.variants[p.variant];
  // bras et armes de la vue du joueur (fichiers « vue ») ; absents : vue du joueur sans bras. Joueurs en modèles d'agents
  // (fichiers « joueurs ») ; absents : silhouettes
  const assets = useAssets3d().data, vue = assets?.vue, joueurs = assets?.joueurs;
  // la liste est relue (5 min, fichier en échec) : ne recharger les bras que si ses fichiers ont changé (nouvel envoi) ;
  // calculé au changement de la liste seulement, pas à chaque image de la lecture
  const vueKey = useMemo(() => (vue ? Object.entries(vue.files).map(([k, f]) => `${k}=${f.url}`).sort().join(",") : ""), [vue]);
  const [arms, setArms] = useState(false);  // bras dessinés à la dernière image (`data-arms`)
  // même règle pour les fichiers « joueurs » : rechargés seulement si leurs adresses changent
  const joueursKey = useMemo(() => (joueurs ? Object.entries(joueurs.files).map(([k, f]) => `${k}=${f.url}`).sort().join(",") : ""), [joueurs]);
  const [agents, setAgents] = useState(false);  // joueurs dessinés en modèles à la dernière image (`data-agents`)
  const [ragdolls, setRagdolls] = useState(0);  // morts dont la trajectoire du ragdoll est prête (`data-ragdolls`)
  // carte affichée en entier (sa dernière version chargée) : la collision ne se télécharge qu'ensuite
  const [shownMap, setShownMap] = useState<string | null>(null);
  const collision = p.map3d.variants.collision;

  useEffect(() => {
    const gl = canvas.current!.getContext("webgl2");
    if (!gl) { fail.current("WebGL 2 n'est pas disponible dans ce navigateur"); return; }
    const v = new Viewer(canvas.current!, gl, readTheme(), (reason) => fail.current(reason));
    v.onFollow = setFollowed;
    v.onBoard = setBoard;
    // voile blanc des flashs : variable CSS `--r3-flash` du seul `.r3-veil` (pas de la vue : un fondu restylerait tout le
    // HUD à chaque image), écrite sans rendu React ; reprise par le voile quand il apparaît
    v.onFlash = veil.set;
    v.onArms = setArms;
    v.onAgents = setAgents;
    v.onRagdolls = setRagdolls;
    v.onMapLost = () => setReload((n) => n + 1);
    // fichier « vue » introuvable (404) : liste relue (`shouldRefreshAssets` ; autres échecs : le ViewModel réessaie seul).
    // Fichier ré-exporté : nouvelles adresses, `vueKey` change et les bras sont rechargés ; sinon le ViewModel garde ses
    // essais. Échecs simultanés (bras, arme tenue, préchargements) : une seule lecture, celle en cours
    // (`cancelRefetch: false`) ; échecs étalés : une lecture chacun, au plus une toutes les 10 s par fichier (délai du
    // ViewModel avant un nouvel essai). Seul cas encore répété : un fichier listé mais retiré du disque à la main (404
    // à chaque essai) ; le renvoyer, ou retirer tout le dossier `vue`
    v.onVmError = (_name, err) => {
      if (shouldRefreshAssets(err)) void qc.invalidateQueries({ queryKey: ["assets3d"] }, { cancelRefetch: false });
    };
    // fichier « joueurs » introuvable (404) : même relecture de la liste que pour les fichiers « vue » (nouvelles adresses :
    // `joueursKey` change et les modèles sont rechargés ; autres échecs : la bibliothèque des agents réessaie seule)
    v.onAgentsError = (_name, err) => {
      if (shouldRefreshAssets(err)) void qc.invalidateQueries({ queryKey: ["assets3d"] }, { cancelRefetch: false });
    };
    viewer.current = v;
    // taille de la vue : rendu 3D, et échelle du HUD de la vue du joueur (variable CSS `--r3-k`, sans rendu React). Vue
    // cachée (replay en 2D) : taille nulle, rien à refaire ; sa taille revient avec elle
    const ro = new ResizeObserver(([e]) => {
      if (!e.contentRect.width || !e.contentRect.height) return;
      v.resize(e.contentRect.width, e.contentRect.height);
      wrap.current?.style.setProperty("--r3-k", String(hudScale(e.contentRect.width, e.contentRect.height)));
    });
    ro.observe(wrap.current!);
    return () => { ro.disconnect(); v.dispose(); viewer.current = null; };
  }, []);

  // replay repassé en 2D : vue cachée, boucle de dessin arrêtée (aucun travail par image) ; carte, textures, caméra et
  // bras gardés. Retour en 3D : la boucle repart, à l'instant courant (effet suivant)
  useEffect(() => {
    if (p.active) viewer.current?.resume();
    else viewer.current?.pause();
  }, [p.active]);

  // après l'effet de montage : le `Viewer` existe déjà (rien sans WebGL 2)
  useEffect(() => { viewer.current?.setViewmodel(vue ? vmLoader(vue.files) : null); }, [vueKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  // vue cachée (2D) comprise : le Viewer ne demande les fichiers qu'à la reprise
  useEffect(() => { viewer.current?.setAgents(joueurs ? vmLoader(joueurs.files) : null); }, [joueursKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!entry || !viewer.current) return;
    const ctl = new AbortController();
    const shown = () => viewer.current?.shown() === p.map3d.map;
    const show = (e: { url: string; size: number }, v: Variant) => {
      const mini = shown(), what = v === "gray" ? "Carte 3D" : "Textures";
      setLoad({ got: 0, total: e.size, what, mini });
      return fetchGlb(e.url, e.size, (got, total) => setLoad({ got, total, what, mini }), ctl.signal)
        .then(parseGlb)
        .then((root) => { if (!ctl.signal.aborted && viewer.current) viewer.current.setMap(root, p.map3d.world_to_model, p.map3d.map); });
    };
    // texturée : la grise, légère et souvent déjà en cache, s'affiche d'abord ; ce n'est qu'un aperçu, son échec
    // n'empêche pas la texturée
    const first = p.variant === "textured" && !shown() ? p.map3d.variants.gray ?? null : null;
    (first ? show(first, "gray").catch((e: Error) => { if (ctl.signal.aborted) throw e; }) : Promise.resolve())
      .then(() => show(entry, p.variant))
      .then(() => { if (!ctl.signal.aborted) { setLoad(null); setShownMap(p.map3d.map); } })
      .catch(async (e: Error) => {
        if (ctl.signal.aborted) return;
        // fichier introuvable : la carte a pu être ré-exportée depuis la lecture de la liste (l'ancien fichier est
        // supprimé) ; on relit celle-ci, une fois, et sa nouvelle adresse relance ce chargement
        if (e instanceof LoadError && e.status === 404 && !relisted.current) {
          relisted.current = true;
          if (await freshUrl(qc, p.map3d.map, p.variant, entry.url) || ctl.signal.aborted) return;
        }
        setLoad(null);
        // la texturée a échoué mais la grise est là : on la garde plutôt que de fermer la 3D (fonction du dernier rendu :
        // en 2D, la page y reste)
        if (p.variant === "textured" && shown()) onVariant.current("gray");
        else fail.current(`la carte n'a pas pu être chargée (${e.message})`);
      });
    return () => ctl.abort();
  }, [entry?.url, reload]);  // eslint-disable-line react-hooks/exhaustive-deps

  // collision de la carte (morts en ragdoll), une fois la carte affichée : triangles du jeu posés sur la vue. Absente ou
  // en échec : aucune, les morts gardent leurs clips (rien vers onFail). La scène lue n'est jamais dessinée : rien sur la
  // carte graphique, le ramasse-miettes la libère
  useEffect(() => {
    const v = viewer.current;
    if (!v || shownMap !== p.map3d.map) return;
    if (!collision) { v.setCollision(p.map3d.map, null); return; }
    const ctl = new AbortController();
    fetchGlb(collision.url, collision.size, () => {}, ctl.signal)
      .then(parseGlb)
      .then((root) => { if (!ctl.signal.aborted) viewer.current?.setCollision(p.map3d.map, collisionFromScene(root, p.map3d.world_to_model)); })
      .catch((e: unknown) => { if (!ctl.signal.aborted) console.warn("Collision 3D non chargée : morts en clips", e); });
    return () => ctl.abort();
  }, [collision?.url, shownMap]);  // eslint-disable-line react-hooks/exhaustive-deps

  // vue cachée : rien (la page ne la rend d'ailleurs plus, `LazyScene3D`) ; affichée de nouveau : l'instant courant
  useEffect(() => {
    if (!p.active) return;
    viewer.current?.setFrame(p.replay, p.tick, p.selected);
    frame.current = { replay: p.replay, tick: p.tick };
  }, [p.replay, p.tick, p.selected, p.active]);
  useEffect(() => { viewer.current?.setMode(mode); }, [mode]);
  // raccourci « Recentrer le radar » (0) : en 3D, recadre la carte ; en 2D, le radar seul (caméra 3D gardée)
  useEffect(() => {
    if (!p.active) return;
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === "reset") viewer.current?.recenter(); };
    window.addEventListener("radar-zoom", on);
    return () => window.removeEventListener("radar-zoom", on);
  }, [p.active]);

  // clic sans glisser = choisir un joueur (un glisser fait tourner la caméra)
  const onClick = (e: React.MouseEvent) => {
    const d = down.current, v = viewer.current;
    if (!d || !v || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const r = canvas.current!.getBoundingClientRect();
    const sid = v.pick(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (sid) p.onSelect(sid === p.selected ? null : sid);
  };
  const variants = (["gray", "textured"] as const).filter((v) => p.map3d.variants[v]);
  const part = load && load.total ? Math.min(1, load.got / load.total) : null;

  return (
    <div ref={wrap} className="r3-scene" data-testid="scene3d" data-state={load ? "loading" : "ready"} data-mode={mode}
      data-arms={arms ? "on" : "off"} data-agents={agents ? "on" : "off"} data-ragdolls={ragdolls} hidden={!p.active}>
      <canvas ref={canvas} className="r3-canvas" role="img" aria-label="Vue 3D du replay"
        onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }} onClick={onClick} />
      <AdrWatch matchId={p.replay.payload.match_id} round={p.replay.payload.round.number} onAdr={setAdr} />
      {/* vue cachée : pas de HUD (son petit radar se redessine à sa cadence ; sa présence masque le fil des kills de la
          page, replay3d.css) ; il revient avec la vue, joueur suivi et tableau gardés */}
      {p.active && <PovLayer mode={mode} followed={followed} board={board} ct={p.score.ct} t={p.score.t}
        windowHeight={windowHeight} radar={radar} adr={adr} veilRef={veil.ref} />}
      <div className="r3-bar" role="group" aria-label="Caméra 3D">
        {MODES.map((m) => (
          <button key={m.id} type="button" className={`btn btn-sm btn-ghost ${mode === m.id ? "on" : ""}`} aria-pressed={mode === m.id}
            title={m.title} onClick={() => setMode(m.id)} data-testid={`cam-${m.id}`}>{m.label}</button>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" title="Recadrer la carte (0)" onClick={() => viewer.current?.recenter()}
          data-testid="cam-recenter">Recentrer</button>
        {variants.length > 1 && <span className="r3-sep" />}
        {variants.length > 1 && variants.map((v) => (
          <button key={v} type="button" className={`btn btn-sm btn-ghost ${p.variant === v ? "on" : ""}`} aria-pressed={p.variant === v}
            onClick={() => p.onVariant(v)} data-testid={`variant-${v}`}>{v === "gray" ? "Grise" : "Texturée"}</button>
        ))}
      </div>
      {load && (
        <div className={`r3-load ${load.mini ? "mini" : ""}`} data-testid="scene3d-progress">
          <span aria-hidden="true">{load.what} : {mb(load.got)} / {mb(load.total)} Mo</span>
          {/* pas de région annoncée : le texte change à chaque Mo, la barre se lit à la demande */}
          <span className="r3-progress" role="progressbar" aria-label={`${load.what} : chargement`} aria-valuemin={0}
            aria-valuemax={100} aria-valuenow={part === null ? undefined : Math.round(part * 100)}>
            <i style={{ transform: `scaleX(${part ?? 0.3})` }} />
          </span>
        </div>
      )}
    </div>
  );
}
