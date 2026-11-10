// Lecture d'un texte KV3 (sortie « -b <bloc> » de Source2Viewer-CLI) : objets { clé = valeur }, tableaux [ a, b ] (virgules
// finales admises), textes entre guillemets, nombres, true / false / null. Le commentaire d'en-tête <!-- … --> est ignoré ;
// seul le premier objet est lu. Rien d'autre (ressources, blobs binaires #[ … ]) : erreur qui dit où.
export function parseKv3(text) {
  const end = text.indexOf("-->"), s = text;
  let i = text.indexOf("{", end < 0 ? 0 : end + 3);
  if (i < 0) throw new Error("KV3 : aucun objet");
  const ws = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };
  function value() {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      const o = {};
      for (;;) {
        ws();
        if (s[i] === "}") { i++; return o; }
        const k = /^[A-Za-z0-9_.]+/.exec(s.slice(i, i + 200))?.[0];
        if (!k) throw new Error(`Clé illisible à ${i} : ${s.slice(i, i + 20)}`);
        i += k.length;
        ws();
        if (s[i] !== "=") throw new Error(`« = » attendu après ${k}`);
        i++;
        o[k] = value();
      }
    }
    if (c === "[") {
      i++;
      const a = [];
      for (;;) {
        ws();
        if (s[i] === "]") { i++; return a; }
        a.push(value());
      }
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) throw new Error(`Texte non fermé à ${i}`);
      const v = s.slice(i + 1, j);
      i = j + 1;
      return v;
    }
    const m = /^(-?[0-9.eE+-]+|true|false|null)/.exec(s.slice(i, i + 40));
    if (!m) throw new Error(`Valeur illisible à ${i} : ${s.slice(i, i + 20)}`);
    const n = m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
    if (Number.isNaN(n)) throw new Error(`Nombre illisible à ${i} : ${m[0]}`);
    i += m[0].length;
    return n;
  }
  return value();
}
