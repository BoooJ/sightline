import { RoleBadges } from "../../players/Filters";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../../shared/api/client";
import type { MatchSummary, Side, StoryRound, StoryStep, Vec3 } from "../../../shared/api/types";
import { usePlaceAt, usePlaceLabel } from "../../../shared/callouts";
import { formatDate } from "../../../shared/format";
import { useMyPlayer } from "../../../shared/myPlayer";
import { downloadText, lineupCfg } from "../../../shared/practiceCfg";
import { saveStudy, studyUrl, type StudyItem } from "../../../shared/study";
import { useUrlParams } from "../../../shared/useUrlParams";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Icon } from "../../../shared/ui/Icon";
import { Spinner } from "../../../shared/ui/Spinner";
import { Popover } from "../../../shared/ui/Popover";
import { bestRound, BUY_LABEL, isArmed, roundClock, situation, stepText, type PlaceName } from "./story";
import { NADE } from "../../grenades/GrenadesPage";
import { CoachPanel } from "./Coach";
import { Routine } from "./Routine";
import { StoryMap, stepColor, Timeline } from "./StoryMap";
import "./story.css";

/** Apprendre un rôle, version simple : on choisit une démo et un joueur, puis on suit ses rounds racontés étape par
 *  étape sur la carte. L'analyse détaillée (postes de toute la bibliothèque) reste sur /learn/expert. */
export function StoryPage() {
  const [params, set] = useUrlParams();
  const loc = useLocation();
  const nav = useNavigate();
  const matchId = Number(params.get("match")) || undefined;
  const player = params.get("player") ?? undefined;

  // anciens liens (postes, rôles) : vers l'analyse détaillée
  useEffect(() => {
    if (["place", "mode", "tab", "role", "at", "map"].some((k) => params.has(k)) && !matchId) nav(`/learn/expert${loc.search}`, { replace: true });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // l'histoire d'un joueur occupe tout l'écran : l'en-tête de la page (titre, étapes) ne sert qu'aux deux choix
  if (matchId && player) {
    return (
      <div className="sy">
        <Story matchId={matchId} steamid={player} onChangePlayer={() => set({ player: null, side: null, round: null, step: null })}
          onChangeDemo={() => set({ match: null, player: null, side: null, round: null, step: null })} />
      </div>
    );
  }
  return (
    <div className="sy">
      <header className="sy-head">
        <div>
          <h1 className="sy-title">Apprendre un rôle</h1>
          <p className="sy-intro">Choisis un joueur dans une démo, puis suis ses rounds étape par étape.</p>
        </div>
        <ol className="sy-stepper" aria-label="Étapes">
          <li className={!matchId ? "on" : "done"}><b>1</b>Démo</li>
          <li className={matchId ? "on" : ""}><b>2</b>Joueur</li>
          <li><b>3</b>Ses rounds</li>
        </ol>
        <Link to="/learn/expert" className="btn btn-sm btn-ghost sy-expert">Analyse détaillée (mode expert)</Link>
      </header>
      <Pick matchId={matchId} onMatch={(id) => set({ match: id ? String(id) : null, player: null })}
        onPlayer={(sid) => set({ player: sid, side: null, round: null, step: null })} />
    </div>
  );
}

// ------------------------------------------------------------------ étapes 1 et 2 : démo puis joueur

function Pick({ matchId, onMatch, onPlayer }: { matchId?: number; onMatch: (id?: number) => void; onPlayer: (sid: string) => void }) {
  const me = useMyPlayer();
  const matches = useQuery({ queryKey: ["matches", "", ""], queryFn: () => api.matches() });
  const match = useQuery({ queryKey: ["match", matchId], queryFn: () => api.match(matchId!), enabled: !!matchId });
  // rôles joués (entry, AWPer, ancre…) : pour choisir le joueur qui tient le rôle qu'on veut apprendre
  const career = useQuery({ queryKey: ["players-roles"], queryFn: () => api.players({}), enabled: !!matchId, staleTime: 60_000 });
  const rolesOf = (sid: string) => career.data?.find((c) => c.steamid === sid)?.roles;
  if (matches.isLoading) return <div className="sy-body"><Spinner /></div>;
  if (!matches.data?.length) return <div className="sy-body"><EmptyState title="Aucune démo">Importe une démo depuis la bibliothèque pour commencer.</EmptyState></div>;

  if (!matchId) {
    return (
      <section className="sy-body">
        <h2 className="sy-h">Quelle démo veux-tu regarder ?</h2>
        <div className="sy-demos" data-testid="story-demos">
          {matches.data.map((m: MatchSummary) => (
            <button key={m.id} type="button" className="sy-demo" onClick={() => onMatch(m.id)}>
              <span className="sy-demo-map">{m.map_display_name}</span>
              <span className="sy-demo-teams"><b>{m.team_a.name}</b> <span className="mono">{m.score_a} : {m.score_b}</span> <b>{m.team_b.name}</b></span>
              <span className="sy-demo-date">{formatDate(m.date ?? m.played_at ?? m.imported_at)}</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  const d = match.data;
  return (
    <section className="sy-body">
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onMatch(undefined)}><Icon name="back" />Changer de démo</button>
      <h2 className="sy-h">Quel joueur veux-tu suivre ?</h2>
      {!d ? <Spinner /> : (
        <div className="sy-teams" data-testid="story-players">
          {[d.team_a, d.team_b].map((t) => (
            <div key={t.id} className="sy-team">
              <h3>{t.name}</h3>
              {d.players.filter((p) => p.team_id === t.id).sort((a, b) => b.kills - a.kills).map((p) => (
                <button key={p.steamid} type="button" className={`sy-player ${p.steamid === me ? "me" : ""}`} onClick={() => onPlayer(p.steamid)}>
                  <span className="sy-player-name">{p.name}{p.steamid === me && <em className="badge badge-ok">Moi</em>}</span>
                  <span className="sy-player-roles"><RoleBadges roles={rolesOf(p.steamid)} /></span>
                  <span className="mono">{p.kills} / {p.deaths} · {Math.round(p.adr)} ADR</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ étape 3 : l'histoire d'un round

function Story({ matchId, steamid, onChangePlayer, onChangeDemo }: { matchId: number; steamid: string; onChangePlayer: () => void; onChangeDemo: () => void }) {
  const [params, set] = useUrlParams();
  const me = useMyPlayer();
  const nav = useNavigate();
  const loc = useLocation();
  const q = useQuery({ queryKey: ["story", matchId, steamid], queryFn: () => api.story(matchId, steamid) });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const placeLabel = usePlaceLabel(q.data?.map);
  const name: PlaceName = (p, pos) => placeLabel(p, pos) ?? p ?? null;
  const placeAt = usePlaceAt(q.data?.map);

  const story = q.data;
  const firstSide = story?.rounds[0]?.side ?? "CT";
  const side = (params.get("side") === "T" ? "T" : params.get("side") === "CT" ? "CT" : firstSide) as Side;
  const rounds = useMemo(() => story?.rounds.filter((r) => r.side === side) ?? [], [story, side]);
  const best = useMemo(() => bestRound(rounds), [rounds]);
  // rounds armés seulement par défaut : la routine d'un joueur se voit en achat complet (les ecos la faussent)
  const armedOnly = params.get("rounds") !== "all" && rounds.some(isArmed);
  const shown = armedOnly ? rounds.filter(isArmed) : rounds;
  const round = rounds.find((r) => r.number === Number(params.get("round"))) ?? best;
  const step = Math.min(Number(params.get("step")) || 0, Math.max(0, (round?.steps.length ?? 1) - 1));
  const go = (i: number) => round && set("step", String(Math.max(0, Math.min(round.steps.length - 1, i))));
  const [auto, setAuto] = useState(false);
  const view = params.get("view") === "routine" ? "routine" : "round";
  // enchaîner les rounds : dans la liste affichée (rounds armés ou tous)
  const list = round && shown.includes(round) ? shown : rounds;
  const ri = round ? list.indexOf(round) : -1;
  const prevRound = ri > 0 ? list[ri - 1] : undefined;
  const nextRound = ri >= 0 && ri < list.length - 1 ? list[ri + 1] : undefined;
  const goRound = (r?: StoryRound, atEnd = false) => r && set({ round: String(r.number), step: atEnd ? String(r.steps.length - 1) : null });
  const last = round ? step >= round.steps.length - 1 : true;
  const next = () => (last ? goRound(nextRound) : go(step + 1));
  const prev = () => (step > 0 ? go(step - 1) : goRound(prevRound, true));
  // plein écran de toute la vue : rounds, carte, étapes et navigation restent accessibles
  const rootRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement && document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setFull((v) => !v)); else setFull((v) => !v);  // repli : vue étendue dans la page
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, select, textarea")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      if (e.key === "PageDown" || e.key === "n" || e.key === "N") { e.preventDefault(); goRound(nextRound); }
      if (e.key === "PageUp" || e.key === "p" || e.key === "P") { e.preventDefault(); goRound(prevRound); }
      if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFull(); }
      if (e.key === "Escape" && full && !document.fullscreenElement) setFull(false);
      if (e.key === " " && !(e.target as HTMLElement)?.closest("button, a")) { e.preventDefault(); setAuto((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (!auto || !round) return;
    if (last && !nextRound) { setAuto(false); return; }
    // la lecture auto passe au round suivant après une pause un peu plus longue
    const id = setTimeout(next, last ? 4000 : 3000);
    return () => clearTimeout(id);
  });  // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <div className="sy-body"><Spinner /></div>;
  if (q.isError || !story) return <div className="sy-body"><EmptyState title="Histoire indisponible">Ce joueur ou cette démo est introuvable.</EmptyState></div>;
  const map = maps.data?.find((m) => m.name === story.map);
  const isMe = steamid === me;
  const cur = round?.steps[step];

  const replay = () => {
    if (!round) return;
    const from = round.steps[step];
    const marks = round.steps.filter((s) => s.tick >= from.tick && s.kind !== "end").map((s) => {
      const t = stepText(s, name);
      return { tick: s.tick, text: `${t.title} : ${t.text.replace(/\*\*/g, "")}` };
    });
    const item: StudyItem = { match_id: story.match_id, round_number: round.number, steamid, start: Math.max(round.start_tick, from.tick - 3 * story.rate),
      end: round.round_end_tick, label: `${story.name} · round ${round.number}`, marks };
    saveStudy({ title: `Histoire de ${story.name} — round ${round.number}`, back: loc.pathname + loc.search, items: [item], pauses: true });
    nav(studyUrl(item, 0));
  };

  return (
    <div className={`sy-story ${full ? "is-full" : ""}`} ref={rootRef} data-testid="story-root">
      <h1 className="sr-only">Apprendre un rôle : {story.name}</h1>
      {/* une seule ligne d'en-tête : qui, camp, vue ; le reste dans le menu « ⋯ » */}
      <div className="sy-top">
        <button type="button" className="btn btn-sm btn-ghost sy-back" onClick={onChangePlayer} aria-label="Changer de joueur" title="Changer de joueur"><Icon name="back" /></button>
        <span className="sy-who"><b>{story.name}</b>{isMe && <em className="badge badge-ok">Moi</em>}
          <span>{story.team} vs {story.opponent}{map ? ` · ${map.display_name}` : ""}</span></span>
        <div className="map-pills" role="group" aria-label="Camp">
          {(["CT", "T"] as Side[]).map((s) => (
            <button key={s} type="button" className={`pill ${side === s ? "on" : ""}`} aria-pressed={side === s} title={s === "CT" ? "Ses rounds en défense" : "Ses rounds en attaque"}
              onClick={() => set({ side: s, round: null, step: null })}>{s}</button>
          ))}
        </div>
        <div className="map-pills" role="group" aria-label="Vue" data-testid="story-view">
          <button type="button" className={`pill ${view === "round" ? "on" : ""}`} aria-pressed={view === "round"} onClick={() => set({ view: null })}>Étape par étape</button>
          <button type="button" className={`pill ${view === "routine" ? "on" : ""}`} aria-pressed={view === "routine"} onClick={() => set({ view: "routine" })} data-testid="view-routine">Sa routine</button>
        </div>
        <span className="sy-top-end">
          <button type="button" className={`btn btn-sm btn-ghost ${full ? "on" : ""}`} onClick={toggleFull} aria-pressed={full} data-testid="story-full"
            aria-label={full ? "Quitter le plein écran" : "Plein écran"} title="Plein écran (F)"><Icon name="fullscreen" /></button>
          <Popover label="Plus d'options" button={<Icon name="more" />} testId="story-menu">
            {(close) => (
              <div className="sy-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { close(); onChangePlayer(); }}><Icon name="user" />Changer de joueur</button>
                <button type="button" role="menuitem" onClick={() => { close(); onChangeDemo(); }}><Icon name="library" />Changer de démo</button>
                <Link role="menuitem" to="/learn/expert" onClick={close}><Icon name="layers" />Analyse détaillée (mode expert)</Link>
                <p className="sy-keys"><Icon name="keyboard" />← → étapes · N / P rounds · Espace lecture · F plein écran</p>
              </div>
            )}
          </Popover>
        </span>
      </div>

      {view === "routine" && map ? (
        <Routine matchId={story.match_id} steamid={steamid} side={side} map={map}
          onRound={(r) => (r.match_id === story.match_id ? set({ view: null, round: String(r.number), step: null })
            : nav(`/learn?match=${r.match_id}&player=${steamid}&side=${side}&round=${r.number}`))} />
      ) : <>

      <div className="sy-rounds" role="group" aria-label="Rounds (étoile : round conseillé ; vert : gagné ; rouge : perdu)" data-testid="story-rounds">
        {rounds.some(isArmed) && (
          <div className="map-pills sy-filter" role="group" aria-label="Rounds montrés" data-testid="rounds-filter">
            <button type="button" className={`pill ${armedOnly ? "on" : ""}`} onClick={() => set({ rounds: null })} title="Achat complet : c'est là que sa routine se voit">Rounds armés ({rounds.filter(isArmed).length})</button>
            <button type="button" className={`pill ${!armedOnly ? "on" : ""}`} onClick={() => set({ rounds: "all" })}>Tous ({rounds.length})</button>
          </div>
        )}
        {shown.map((r) => (
          <button key={r.number} type="button" title={roundTitle(r, name)} aria-label={roundTitle(r, name)} aria-current={r.number === round?.number}
            className={`sy-round ${r.won ? "won" : r.won === false ? "lost" : ""} ${r.number === round?.number ? "on" : ""}`}
            onClick={() => set({ round: String(r.number), step: null })}>
            <b>{r.number}</b>
            {r.buy !== "full" && <span className={`sy-buy b-${r.buy}`}>{BUY_LABEL[r.buy] ?? r.buy}</span>}
            {r === best && <span className="sy-best"><Icon name="star" size={11} /></span>}
          </button>
        ))}
        {!rounds.length && <p className="sy-hint">Aucun round dans ce camp.</p>}
      </div>

      {round && map && cur ? (
        <div className="sy-main">
          <div className="sy-stage">
            <StoryMap map={map} round={round} current={step} label={name(cur.place, cur.pos)} />
            <div className="sy-transport" role="group" aria-label="Lecture du round" data-testid="story-transport">
              <button type="button" className="btn btn-ghost sy-tbtn" onClick={prev} disabled={step === 0 && !prevRound} data-testid="story-prev"
                aria-label="Étape précédente" title="Étape précédente (←)"><Icon name="back" /></button>
              <button type="button" className={`btn sy-tbtn ${auto ? "on" : ""}`} onClick={() => setAuto(!auto)} aria-pressed={auto}
                aria-label={auto ? "Pause" : "Lecture automatique"} title="Lecture automatique (Espace) : enchaîne les étapes puis les rounds"><Icon name={auto ? "pause" : "play"} /></button>
              <Timeline round={round} current={step} onSelect={go} />
              <span className="sy-counter mono" aria-live="polite">{step + 1}/{round.steps.length}</span>
              <button type="button" className="btn btn-primary sy-next" onClick={next} disabled={last && !nextRound} data-testid="story-next" title="Étape suivante (→)">
                {last && nextRound ? `Round ${nextRound.number}` : "Suivant"}<Icon name="next" /></button>
            </div>
          </div>
          <aside className="sy-panel">
            <div className="sy-round-head">
              <h2>Round {round.number}</h2>
              <span className={`badge ${round.won ? "badge-ok" : "badge-error"}`}>{round.won ? "Gagné" : "Perdu"}</span>
              {round.poste && <span className="sy-poste" title="Son poste dans ce round">{name(round.poste)}</span>}
              <button type="button" className="btn btn-sm sy-replay" onClick={replay} data-testid="story-replay" title={`Le replay suit ${story.name} et s'arrête à chaque étape avec son explication.`}>
                <Icon name="play" />Replay</button>
            </div>
            <Current round={round} step={step} name={name} />
            <SituationLine round={round} step={step} placeAt={placeAt} />
            {cur.kind === "nade" && <Lineup s={cur} map={story.map} label={`${story.name} · round ${round.number}`} />}
            <section className="sy-flow" aria-label="Déroulé du round">
              <h3 className="sy-sub">Déroulé</h3>
              <ol className="sy-steps" data-testid="story-steps">
                {round.steps.map((s, i) => {
                  const t = stepText(s, name);
                  return (
                    <li key={i}>
                      <button type="button" className={i === step ? "on" : i < step ? "past" : ""} aria-current={i === step ? "step" : undefined} onClick={() => go(i)}>
                        <i className={`sy-dot ${s.kind === "death" ? "sq" : ""}`} style={{ ["--c" as string]: stepColor(s) }}>{i + 1}</i>
                        <Clock t={s.t} plantT={round.plant_t} />
                        <span>{t.text.replace(/\*\*/g, "")}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
            <details className="sy-more" data-testid="story-more">
              <summary>Aller plus loin : coach, assistant{isMe ? ", comparer" : ""}, aide</summary>
              <CoachPanel request={{ kind: "round", match: story.match_id, steamid, round: round.number }} label="Explique-moi ce round"
                intro="Le coach raconte le round et dit quoi reproduire." />
              <Link className="pl-link sy-ask" data-testid="story-ask" to={`/assistant?q=${encodeURIComponent(`Sur la démo ${story.match_id}, round ${round.number}, je suis ${story.name} (steamid ${steamid}) à l'étape ${step + 1}. Utilise /api/scouting/story?match=${story.match_id}&steamid=${steamid} pour répondre : `)}`}>Poser une autre question sur ce round à l'assistant</Link>
              {isMe && round.poste && <Compare map={map.name} side={side} poste={round.poste} posteName={name(round.poste) ?? round.poste} me={steamid} />}
              <Help />
            </details>
          </aside>
        </div>
      ) : rounds.length > 0 && <Spinner />}
      </>}
    </div>
  );
}

function roundTitle(r: StoryRound, name: PlaceName): string {
  const poste = r.poste ? ` · ${name(r.poste) ?? r.poste}` : "";
  return `Round ${r.number} · ${BUY_LABEL[r.buy] ?? r.buy} · ${r.won ? "gagné" : "perdu"} · ${r.kills} kill${r.kills > 1 ? "s" : ""} · ${r.died ? "mort" : "survit"}${poste}`;
}

/** Texte de l'étape en cours, en grand, avec les lieux et joueurs en gras. */
function Current({ round, step, name }: { round: StoryRound; step: number; name: PlaceName }) {
  const s = round.steps[step];
  const t = stepText(s, name);
  return (
    <div className="sy-card" style={{ borderColor: stepColor(s) }} data-testid="story-card">
      <div className="sy-card-head">
        <i className={`sy-dot big ${s.kind === "death" ? "sq" : ""}`} style={{ ["--c" as string]: stepColor(s) }}>{step + 1}</i>
        <span className="sy-card-title">{t.title}</span>
        <span className="sy-card-t">{s.kind === "buy" ? "Freeze time · " : ""}<Clock t={s.t} plantT={round.plant_t} /></span>
      </div>
      <p className="sy-card-text">{t.text.split("**").map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}</p>
    </div>
  );
}

/** Quand c'est moi : l'histoire d'un autre joueur qui a gagné au même poste, pour comparer. */
function Compare({ map, side, poste, posteName, me }: { map: string; side: Side; poste: string; posteName: string; me: string }) {
  const [, set] = useUrlParams();
  const [ask, setAsk] = useState(false);
  const q = useQuery({ queryKey: ["learn", map, side, poste, 20], queryFn: () => api.learn(map, side, poste), enabled: ask });
  const other = useMemo(() => (q.data?.entries ?? []).filter((e) => e.steamid !== me && e.won)
    .sort((a, b) => b.kills - a.kills || (a.death ? 1 : 0) - (b.death ? 1 : 0))[0], [q.data, me]);
  useEffect(() => {
    if (other) set({ match: String(other.match_id), player: other.steamid, side, round: String(other.round_number), step: null });
  }, [other]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="sy-compare">
      <p>Tu as joué <b>{posteName}</b>. Comment un autre joueur l'a-t-il joué en gagnant le round ?</p>
      <button type="button" className="btn btn-sm" onClick={() => setAsk(true)} disabled={ask && q.isLoading} data-testid="story-compare">
        <Icon name="team" />Voir un autre joueur à ce poste</button>
      {ask && q.isSuccess && !other && <p className="sy-keys">Personne d'autre n'a encore gagné de round à ce poste dans ta bibliothèque.</p>}
    </div>
  );
}

const NADE_LABEL: Record<string, string> = { smoke: "Smoke", flash: "Flash", he: "HE", molotov: "Molotov", incendiary: "Incendiaire", decoy: "Leurre" };

/** Lineup d'une grenade : où se placer et où viser pour refaire le même lancer dans CS2. */
function Lineup({ s, map, label }: { s: StoryStep; map: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const type = s.nade ?? "smoke";
  return (
    <div className="sy-lineup" data-testid="story-lineup-box">
      <span className="sy-lineup-h">Lineup</span>
      <p>Place-toi au point de lancer (repère numéroté) et vise dans la direction de la flèche blanche. La grenade suit la courbe en pointillés.</p>
      {s.setpos ? (<>
        <code className="mono" data-testid="story-setpos">{s.setpos}</code>
        <div className="sy-lineup-actions">
          <button type="button" className="btn btn-sm" onClick={() => {
            navigator.clipboard?.writeText(s.setpos!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
          }}>{copied ? "Copié !" : "Copier la position"}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadText(`lineup_${map}_${type}.cfg`,
            lineupCfg(map, { type, setpos: s.setpos!, label: `${NADE_LABEL[type] ?? type} · ${label}` }))}><Icon name="download" />Config CS2 (.cfg)</button>
        </div>
        <p className="sy-keys">Colle-la dans la console CS2 (serveur avec sv_cheats 1) pour te retrouver exactement au même endroit, avec le même angle.</p>
      </>) : <p className="sy-keys">Angle de visée indisponible pour ce lancer.</p>}
    </div>
  );
}

/** Horloge du jeu à cet instant : temps du round (1:55 qui descend) ou compte à rebours de la bombe. */
function Clock({ t, plantT }: { t: number; plantT: number | null }) {
  const c = roundClock(t, plantT);
  return (
    <span className={`mono sy-clock ${c.bomb ? "bomb" : ""}`} title={c.bomb ? "Compte à rebours de la bombe (40 s)" : "Temps restant du round (1:55)"}>
      {c.bomb && <Icon name="bomb" size={11} />}{c.text}
    </span>
  );
}

/** Ce qui entoure le joueur à cette étape : rapport de force, coéquipier le plus proche, utilitaire ennemi actif. */
function SituationLine({ round, step, placeAt }: { round: StoryRound; step: number; placeAt: (pos: Vec3 | null) => string | null }) {
  const s = round.steps[step];
  const sit = situation(s, placeAt);
  const enemySide = round.side === "CT" ? "T" : "CT";
  return (
    <div className="sy-situ" data-testid="story-situation">
      <span className="sy-situ-h">Situation</span>
      <p><Icon name="team" size={13} /><span><b>{sit.mates}</b> {round.side} en vie contre <b>{sit.enemies}</b> {enemySide}</span></p>
      {s.kind !== "death" && s.kind !== "end" && (
        <p><Icon name="user" size={13} />{sit.nearest
          ? <span>Coéquipier le plus proche : <b>{sit.nearest.name}</b> à {sit.nearest.meters} m{sit.nearest.meters > 40 ? " (il joue seul de son côté)" : ""}</span>
          : <span>Aucun coéquipier en vie : il est seul.</span>}</p>
      )}
      {sit.utility.length > 0 ? (
        <ul className="sy-situ-util">
          {sit.utility.map((u, i) => (
            <li key={i}><i style={{ background: NADE[u.type]?.color }} />
              {u.flying
                ? <>{MASC.has(u.type) ? "Un" : "Une"} <b>{u.label}</b> {MASC.has(u.type) ? "ennemi" : "ennemie"} est en vol ({u.thrower})</>
                : <><b>{cap(u.label)}</b> {MASC.has(u.type) ? "ennemi" : "ennemie"}{u.where ? <> à <b>{u.where}</b></> : null} ({u.thrower})</>}
            </li>
          ))}
        </ul>
      ) : <p className="sy-situ-none"><Icon name="grenade" size={13} />Pas d'utilitaire ennemi actif à ce moment.</p>}
    </div>
  );
}

const MASC = new Set(["molotov", "decoy"]);  // « un molotov », « un leurre » ; les autres grenades sont au féminin
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const HELP_KEY = "story-help-hidden";

/** Mode d'emploi de la page, masquable (mémorisé sur cet appareil). */
function Help() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HELP_KEY) === "1"; } catch { return false; } });
  if (hidden) {
    return <button type="button" className="btn btn-sm btn-ghost sy-help-open" onClick={() => { setHidden(false); try { localStorage.removeItem(HELP_KEY); } catch { /* */ } }}>
      Comment lire cette page ?</button>;
  }
  return (
    <div className="sy-help" data-testid="story-help">
      <div className="sy-help-head"><b>Comment lire cette page</b>
        <button type="button" className="btn btn-sm btn-ghost" aria-label="Masquer l'aide"
          onClick={() => { setHidden(true); try { localStorage.setItem(HELP_KEY, "1"); } catch { /* */ } }}><Icon name="close" size={12} /></button></div>
      <ol>
        <li>Choisis un round en haut (étoile = conseillé pour commencer).</li>
        <li>Avance avec « Suivant » sous la carte, ou les flèches ← → ; « Lecture auto » déroule le round tout seul.</li>
        <li>Sur la carte : lui, ses coéquipiers, les ennemis et leurs grenades à cet instant. Regarde où il se place par rapport à eux.</li>
      </ol>
    </div>
  );
}
