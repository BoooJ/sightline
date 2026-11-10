import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client";
import type { Annotations, Shape } from "../../../shared/api/types";

/** Dessins + note d'un round : chargement, annulation (Ctrl+Z) et enregistrement automatique (différé de 600 ms). */
export function useAnnotations(roundId: number | undefined, matchId: number) {
  const qc = useQueryClient();
  const [data, setData] = useState<Annotations>({ shapes: [], note: "" });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const history = useRef<Shape[][]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<{ id: number; a: Annotations } | null>(null);

  const flush = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setStatus("saving");
    try {
      await api.saveAnnotations(p.id, p.a);
      setStatus("saved");
      qc.setQueryData(["annotations", p.id], p.a);
      qc.invalidateQueries({ queryKey: ["annotated", matchId] });
    } catch { setStatus("error"); }
  }, [qc, matchId]);

  useEffect(() => {
    history.current = [];
    setStatus("idle");
    if (!roundId) return;
    let alive = true;
    const cached = qc.getQueryData<Annotations>(["annotations", roundId]);
    if (cached) setData(cached); else setData({ shapes: [], note: "" });
    qc.fetchQuery({ queryKey: ["annotations", roundId], queryFn: () => api.annotations(roundId), staleTime: 30_000 })
      .then((a) => { if (alive) setData(a); }).catch(() => {});
    return () => { alive = false; clearTimeout(timer.current); void flush(); };  // enregistre avant de changer de round
  }, [roundId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: Annotations) => {
    setData(next);
    if (!roundId) return;
    pending.current = { id: roundId, a: next };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
  };
  const setShapes = (shapes: Shape[]) => { history.current.push(data.shapes); commit({ ...data, shapes }); };
  return {
    shapes: data.shapes, note: data.note, status,
    add: (s: Shape) => setShapes([...data.shapes, s]),
    erase: (id: string) => setShapes(data.shapes.filter((s) => s.id !== id)),
    move: (id: string, points: [number, number][]) => setShapes(data.shapes.map((s) => (s.id === id ? { ...s, points } : s))),
    clear: () => data.shapes.length && setShapes([]),
    undo: () => { const prev = history.current.pop(); if (prev) commit({ ...data, shapes: prev }); },
    setNote: (note: string) => commit({ ...data, note }),
  };
}
