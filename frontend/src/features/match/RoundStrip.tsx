import { useNavigate } from "react-router-dom";
import type { MatchDetail, RoundInfo } from "../../shared/api/types";
import { BUY_LABEL, END_REASON_LABEL, formatMoney } from "../../shared/format";
import { Icon, type IconName } from "../../shared/ui/Icon";

const REASON_ICON: Record<string, IconName> = { bomb_exploded: "bomb", bomb_defused: "defuse" };
const isHalfBreak = (n: number) => n === 12 || (n > 24 && (n - 24) % 3 === 0);

function Cell({ r, teamId, survivors }: { r: RoundInfo; teamId: number; survivors?: number }) {
  const won = r.winner_team_id === teamId;
  const side = r.ct_team_id === teamId ? "ct" : "t";
  const alive = survivors != null && survivors > 0 && <span className="rs-alive mono" title={`${survivors} survivant(s)`}>{survivors}</span>;
  return won ? (
    <span className={`rs-cell rs-win rs-${side}`}><Icon name={REASON_ICON[r.end_reason ?? ""] ?? "skull"} size={13} />{alive}</span>
  ) : <span className={`rs-cell rs-${side}-ghost`}>{alive}</span>;
}

const BOMB_TITLE = { planted: "Bombe posée", exploded: "Bombe explosée", defused: "Bombe désamorcée" } as const;

export function RoundStrip({ m }: { m: MatchDetail }) {
  const nav = useNavigate();
  const buy = (r: RoundInfo, teamId: number) => (r.ct_team_id === teamId ? r.ct_buy_type : r.t_buy_type);
  return (
    <div className="round-strip">
      <div className="rs-labels"><span>{m.team_a.name}</span><span>{m.team_b.name}</span></div>
      <div className="rs-rounds">
        {m.rounds.map((r) => (
          <button key={r.id} type="button" className={`rs-col ${isHalfBreak(r.number) ? "rs-break" : ""}`}
            onClick={() => nav(`/matches/${m.id}/replay/${r.number}`)} data-testid="round-cell"
            aria-label={`Round ${r.number}, gagné par ${r.winner_team_id === m.team_a.id ? m.team_a.name : m.team_b.name} (${r.score_a_after}-${r.score_b_after})`}
            title={`Round ${r.number} — ${r.score_a_after}-${r.score_b_after}\n${END_REASON_LABEL[r.end_reason ?? ""] ?? r.end_reason ?? ""}\n` +
              `CT ${formatMoney(r.ct_equip_value)} (${BUY_LABEL[r.ct_buy_type]}) · T ${formatMoney(r.t_equip_value)} (${BUY_LABEL[r.t_buy_type]})`}>
            <Cell r={r} teamId={m.team_a.id} survivors={r.survivors_a} />
            <span className="rs-num mono">{r.number}{r.bomb && <i className={`rs-bomb ${r.bomb}`} title={BOMB_TITLE[r.bomb]} />}</span>
            <Cell r={r} teamId={m.team_b.id} survivors={r.survivors_b} />
            <span className={`rs-buy rs-buy-${buy(r, m.team_a.id)}`}>{BUY_LABEL[buy(r, m.team_a.id)]?.[0]}</span>
            <span className={`rs-buy rs-buy-${buy(r, m.team_b.id)}`}>{BUY_LABEL[buy(r, m.team_b.id)]?.[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
