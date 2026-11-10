/** Cache Storage factice pour les tests (environnement node : `caches` n'existe pas). Entrées rangées par chemin, dans
 *  l'ordre d'arrivée ; une entrée est en place dès l'appel de `put` (la suite ne dépend pas d'une écriture en cours) ;
 *  `failPut` : écriture refusée (quota plein), `failOpen` : stockage refusé (navigation privée). */
export class FakeCache {
  readonly entries = new Map<string, Response>();
  failPut: Error | null = null;
  readonly puts: string[] = [];  // chemins dont l'écriture a été demandée

  async match(q: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(path(q))?.clone();
  }
  async put(q: RequestInfo | URL, r: Response): Promise<void> {
    this.puts.push(path(q));
    if (this.failPut) throw this.failPut;
    this.entries.delete(path(q));
    this.entries.set(path(q), r);
  }
  async delete(q: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(path(q));
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((p) => new Request(`http://localhost${p}`));
  }
  /** Copie gardée telle quelle (abîmée, ancienne version…). */
  seed(p: string, body: Uint8Array, headers: Record<string, string> = {}): void {
    this.entries.set(p, new Response(body.slice(), { headers }));
  }
  paths(): string[] { return [...this.entries.keys()]; }
  async bytes(p: string): Promise<number[] | null> {
    const r = await this.match(p);
    return r ? [...new Uint8Array(await r.arrayBuffer())] : null;
  }
}

export class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  failOpen: Error | null = null;
  async open(name: string): Promise<FakeCache> {
    if (this.failOpen) throw this.failOpen;
    let c = this.stores.get(name);
    if (!c) this.stores.set(name, (c = new FakeCache()));
    return c;
  }
  async delete(name: string): Promise<boolean> { return this.stores.delete(name); }
  async keys(): Promise<string[]> { return [...this.stores.keys()]; }
}

// chemin de l'adresse : relative (« /api/… », comme les demande le chargeur) ou absolue (clés rendues par `keys`)
const path = (q: RequestInfo | URL) => new URL(typeof q === "string" ? q : q instanceof URL ? q.href : q.url, "http://localhost").pathname;
