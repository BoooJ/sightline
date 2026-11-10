import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { RemoteDownload } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} Mo`;

/** « Importer par lien » : lien de téléchargement d'une démo FACEIT, page de match FACEIT, ou tout lien direct. */
export function ImportUrlButton() {
  const [params, setParams] = useSearchParams();
  const [open, setOpenState] = useState(params.get("import") === "url");
  const setOpen = (v: boolean) => { setOpenState(v); if (!v && params.get("import")) setParams((p) => { const n = new URLSearchParams(p); n.delete("import"); return n; }, { replace: true }); };
  useEffect(() => { if (params.get("import") === "url") setOpenState(true); }, [params]);
  return (<>
    <Button variant="ghost" onClick={() => setOpen(true)} data-testid="import-url"><Icon name="download" />Importer par lien</Button>
    {open && <ImportUrlDialog onClose={() => setOpen(false)} />}
  </>);
}

function ImportUrlDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hltv = /(^|\.)hltv\.org\//i.test(url.trim().replace(/^https?:\/\//, ""));
  const command = `node scripts/hltv-import.mjs "${url.trim() || "https://www.hltv.org/matches/…"}" --carte mirage`;
  const [copied, setCopied] = useState(false);
  const submit = async () => {
    if (hltv) return;
    setErr(null); setBusy(true);
    try { await api.importUrl(url.trim()); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog panel iu-dialog" role="dialog" aria-label="Importer par lien" data-testid="import-url-dialog" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="iu-head"><h2 className="display">Importer par lien</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        <label className="auth-field"><span>Lien de la démo</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoFocus data-testid="import-url-input" /></label>
        <div className="iu-help">
          <b>Match FACEIT</b>
          <ol>
            <li>Ouvrez la page du match sur FACEIT.</li>
            <li>Clic droit sur le bouton « Télécharger la démo » (ou « Watch demo »), puis « Copier l'adresse du lien ».</li>
            <li>Collez le lien ici. Il expire au bout de quelques heures : importez-le tout de suite.</li>
          </ol>
          <b>Démo pro HLTV</b>
          <div className={`iu-hltv ${hltv ? "on" : ""}`} data-testid="import-hltv">
            <p>HLTV (Cloudflare) refuse les téléchargements venant d'un serveur, même avec un vrai navigateur : l'import se fait depuis votre PC,
              avec l'outil fourni, qui récupère la série dans une fenêtre de navigateur, garde la ou les cartes voulues, les compresse (un tiers plus léger)
              et les envoie ici, avec reprise en cas de coupure.</p>
            <p>Dans le dossier du projet, lancez :</p>
            <div className="iu-cmd"><code className="mono" data-testid="hltv-command">{command}</code>
              <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* presse-papiers refusé */ } }}>{copied ? "Copié ✓" : "Copier"}</Button></div>
            <span className="st-legend">--carte : une ou plusieurs cartes (mirage,nuke) ; sans cette option, toutes les cartes de la série sont envoyées.</span>
          </div>
          <span className="st-legend">Fonctionne avec tout lien direct vers une démo CS2 (.dem, .dem.gz, .dem.zst, .dem.bz2) ou une archive (.rar, .zip).
            Le serveur télécharge lui-même, sans passer par votre connexion : utile si votre envoi est lent. Vous pouvez fermer cette fenêtre.</span>
        </div>
        {err && <p className="auth-error" data-testid="import-url-error">{err}</p>}
        <div className="iu-head iu-actions"><span /><Button type="submit" variant="primary" disabled={!url.trim() || busy || hltv} title={hltv ? "Lien HLTV : utilisez l'outil d'import ci-dessus" : undefined}>{busy ? "Vérification…" : "Importer"}</Button></div>
      </form>
    </div>
  );
}

/** Téléchargements en cours ou récents (rafraîchis tant qu'il y en a un actif). */
export function RemoteDownloads() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["remote-downloads"], queryFn: api.remoteDownloads,
    refetchInterval: (query) => ((query.state.data as RemoteDownload[] | undefined)?.some((d) => d.status === "downloading" || d.status === "importing") ? 1000 : false) });
  const [hidden, setHidden] = useState<string[]>([]);
  const items = (q.data ?? []).filter((d) => !hidden.includes(d.id) && d.status !== "done");
  const doneCount = (q.data ?? []).filter((d) => d.status === "done").length;
  useEffect(() => { qc.invalidateQueries({ queryKey: ["demos"] }); }, [doneCount, qc]);
  if (!items.length) return null;
  return (
    <section className="panel imports iu-list" aria-label="Téléchargements">
      {items.map((d) => (
        <div key={d.id} className="import-row" data-testid="remote-row">
          <span className="ir-name">{d.name || d.host}</span>
          {d.status === "error" ? <span className="auth-error iu-err">{d.error}</span> : (
            <span className="iu-prog">
              <span className="st-legend">{d.status === "importing" ? "Ajout à la bibliothèque…" : `Téléchargement ${mb(d.received)}${d.total ? ` / ${mb(d.total)}` : ""}`}</span>
              <span className="iu-bar"><i style={{ transform: `scaleX(${d.total ? Math.min(1, d.received / d.total) : 0.3})` }} /></span>
            </span>
          )}
          {d.status === "error" && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHidden([...hidden, d.id])} aria-label="Masquer">✕</button>}
        </div>
      ))}
    </section>
  );
}
