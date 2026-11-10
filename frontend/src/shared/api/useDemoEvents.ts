import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DemoEvent } from "./types";

/** Écoute /api/events (SSE) ; garde l'état d'avancement des imports en cours. */
export function useDemoEvents(): Record<number, DemoEvent> {
  const qc = useQueryClient();
  const [live, setLive] = useState<Record<number, DemoEvent>>({});
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("demo", (msg) => {
      const ev = JSON.parse((msg as MessageEvent).data) as DemoEvent;
      setLive((prev) => ({ ...prev, [ev.demo_id]: ev }));
      if (ev.status === "ready" || ev.status === "error" || ev.status === "pending") {
        qc.invalidateQueries({ queryKey: ["demos"] });
        qc.invalidateQueries({ queryKey: ["matches"] });
      }
    });
    return () => es.close();
  }, [qc]);
  return live;
}
