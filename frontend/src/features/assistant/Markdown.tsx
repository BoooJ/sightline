import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

/** Rendu Markdown minimal et sûr (aucun HTML injecté) pour les réponses de l'assistant : titres, listes, tableaux,
 *  gras, italique, code et liens (liens internes de l'app ouverts sans recharger la page). */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { const Tag = (h[1].length <= 2 ? "h3" : "h4") as "h3" | "h4"; out.push(<Tag key={i}>{inline(h[2])}</Tag>); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <div key={i} className="md-table"><table>
          {head && <thead><tr>{head.map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead>}
          <tbody>{body.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]/.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, "")); i++; }
      const L = ordered ? "ol" : "ul";
      out.push(<L key={i}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</L>);
      continue;
    }
    if (/^```/.test(l)) {
      const code: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(<pre key={i}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*]|\d+[.)])\s+|\s*\||```)/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={i}>{para.map((t, k) => <Fragment key={k}>{k > 0 && <br />}{inline(t)}</Fragment>)}</p>);
  }
  return <div className="md">{out}</div>;
}

/** Éléments en ligne : **gras**, *italique*, `code`, [lien](url). */
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      const href = lm[2];
      out.push(href.startsWith("/") ? <Link key={k++} to={href}>{lm[1]}</Link>
        : /^https?:\/\//.test(href) ? <a key={k++} href={href} target="_blank" rel="noreferrer noopener">{lm[1]}</a> : lm[1]);
    } else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
