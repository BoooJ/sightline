import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";

const OK = (f: File) => /\.dem(\.bz2)?$/i.test(f.name);

export function DropZone({ onFiles }: { onFiles: (files: File[], rejected: string[]) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) { depth++; setOver(true); e.preventDefault(); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const overFn = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault(); depth = 0; setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      onFiles(files.filter(OK), files.filter((f) => !OK(f)).map((f) => f.name));
    };
    window.addEventListener("dragenter", enter); window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn); window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn); window.removeEventListener("drop", drop);
    };
  }, [onFiles]);
  return (
    <>
      <Button variant="primary" onClick={() => input.current?.click()}><Icon name="upload" />Importer des démos</Button>
      <input ref={input} type="file" accept=".dem,.bz2" multiple hidden onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        onFiles(files.filter(OK), files.filter((f) => !OK(f)).map((f) => f.name));
        e.target.value = "";
      }} />
      {over && <div className="drop-overlay"><Icon name="upload" size={40} /><p>Déposez vos démos pour les importer</p></div>}
    </>
  );
}
