import { useState } from "react";
import { api } from "../../../shared/api/client";
import type { CoachNoteT } from "../../../shared/api/types";
import { Button } from "../../../shared/ui/Button";
import { Icon } from "../../../shared/ui/Icon";
import { Spinner } from "../../../shared/ui/Spinner";
import { Markdown } from "../../assistant/Markdown";

/** Explication de l'IA (récit d'un round ou guide d'un poste), rédigée à partir des faits du logiciel et vérifiée ;
 *  gardée en cache côté serveur (un même round n'est payé qu'une fois). */
export function CoachPanel({ request, label, intro }: { request: Record<string, unknown>; label: string; intro: string }) {
  const key = JSON.stringify(request);
  const [state, setState] = useState<{ key: string; note?: CoachNoteT; error?: string; busy?: boolean } | null>(null);
  const cur = state?.key === key ? state : null;
  const ask = async () => {
    setState({ key, busy: true });
    try { setState({ key, note: await api.coach(request) }); } catch (e) { setState({ key, error: (e as Error).message }); }
  };
  return (
    <section className="cz" data-testid="coach">
      {!cur?.note && (
        <div className="cz-ask">
          <Button variant="primary" onClick={ask} disabled={cur?.busy} data-testid="coach-ask"><Icon name="comment" />{cur?.busy ? "Rédaction…" : label}</Button>
          <span className="st-legend">{intro}</span>
        </div>
      )}
      {cur?.busy && <div className="cz-wait"><Spinner /><span>Le coach rédige à partir des données de la démo, puis le logiciel vérifie chaque horloge et chaque chiffre…</span></div>}
      {cur?.error && <p className="auth-error" role="alert">{cur.error}</p>}
      {cur?.note && (
        <div className="cz-note" data-testid="coach-note">
          {cur.note.blocks.map((b, i) => (
            <div key={i} className="cz-block">
              {b.title && <h4>{b.title}</h4>}
              <Markdown text={b.text} />
            </div>
          ))}
          <p className="st-legend cz-foot">Rédigé par l'IA ({cur.note.model.replace("claude-", "")}) à partir de la démo
            {cur.note.checks.removed_sentences ? ` · ${cur.note.checks.removed_sentences} phrase(s) retirée(s) au contrôle` : " · horloges et chiffres vérifiés"}</p>
        </div>
      )}
    </section>
  );
}
