import type { MatchDetail, PlayerLine } from "../../shared/api/types";

function Table({ name, players, side }: { name: string; players: PlayerLine[]; side: "ct" | "t" }) {
  return (
    <table className="sb-table">
      <thead><tr><th className={`sb-team sb-${side}`}>{name}</th><th>K</th><th>D</th><th>A</th><th>+/−</th><th>ADR</th><th>HS %</th></tr></thead>
      <tbody>
        {[...players].sort((a, b) => b.kills - a.kills).map((p) => {
          const diff = p.kills - p.deaths;
          return (
            <tr key={p.steamid}>
              <td className="sb-name">{p.name}</td>
              <td className="mono">{p.kills}</td><td className="mono">{p.deaths}</td><td className="mono">{p.assists}</td>
              <td className={`mono ${diff > 0 ? "pos" : diff < 0 ? "neg" : ""}`}>{diff > 0 ? `+${diff}` : diff}</td>
              <td className="mono">{p.adr.toFixed(1)}</td><td className="mono">{p.hs_pct.toFixed(0)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Scoreboard({ m }: { m: MatchDetail }) {
  const first = m.rounds[0];
  const sideOf = (teamId: number) => (first && first.ct_team_id === teamId ? "ct" : "t");
  return (
    <div className="scoreboard">
      <Table name={m.team_a.name} side={sideOf(m.team_a.id)} players={m.players.filter((p) => p.team_id === m.team_a.id)} />
      <Table name={m.team_b.name} side={sideOf(m.team_b.id)} players={m.players.filter((p) => p.team_id === m.team_b.id)} />
    </div>
  );
}
