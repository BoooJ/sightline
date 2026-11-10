import { useEffect, useState } from "react";
import { api } from "../../shared/api/client";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";

export function FoldersDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [folders, setFolders] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.settings().then((s) => setFolders(s.demo_folders)); }, []);
  const add = () => { const v = draft.trim(); if (v && !folders.includes(v)) setFolders([...folders, v]); setDraft(""); };
  const save = async () => {
    setBusy(true);
    try { await api.saveSettings({ demo_folders: folders }); await api.scan(); onSaved(); onClose(); }
    finally { setBusy(false); }
  };
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog panel" role="dialog" aria-label="Dossiers de démos" onClick={(e) => e.stopPropagation()}>
        <h3 className="display">Dossiers de démos</h3>
        <p className="dialog-hint">Les démos de ces dossiers (et sous-dossiers) sont importées par « Scanner ». Les fichiers ne sont pas copiés.</p>
        <ul className="folder-list">
          {folders.map((f) => (
            <li key={f}><Icon name="folder" /><span className="mono">{f}</span>
              <Button size="sm" variant="ghost" onClick={() => setFolders(folders.filter((x) => x !== f))}><Icon name="trash" /></Button></li>
          ))}
          {!folders.length && <li className="muted">Aucun dossier.</li>}
        </ul>
        <div className="folder-add">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="C:\\…\\csgo" className="input mono" />
          <Button onClick={add}>Ajouter</Button>
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={busy} onClick={save}>Enregistrer et scanner</Button>
        </div>
      </div>
    </div>
  );
}
