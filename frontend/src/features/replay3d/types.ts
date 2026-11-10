export type Variant = "gray" | "textured";
/** Fichiers d'une carte 3D : ses deux versions affichables et sa collision (maillage physique simplifié, corps des morts ;
 *  scripts/map3d/export.mjs <carte>). */
export type MapFile = Variant | "collision";
export type CameraMode = "free" | "follow" | "pov" | "top" | "tv";

/** Carte 3D envoyée par le module serveur « replay3d » (GET /api/maps3d). */
export interface Map3d {
  map: string; build: string; exported_at: string; checks: Record<string, number>;
  /** coordonnées du jeu → fichier .glb, matrice 4×4 rangée ligne par ligne */
  world_to_model: number[];
  variants: Partial<Record<MapFile, { url: string; size: number }>>;
}

/** Fichier d'un jeu de fichiers 3D (GET /api/assets3d). */
export interface AssetFile { url: string; size: number }
/** Jeu de fichiers 3D : « vue » = bras-ct, bras-t et arme-<clé> (scripts/map3d/export.mjs vue) ; « joueurs » = agent-ct,
 *  agent-t, anims-<jeu> et monde-<clé> (export.mjs joueurs). */
export interface AssetSet { build: string; exported_at: string; files: Record<string, AssetFile> }
/** Jeux de fichiers 3D présents sur le serveur, par type. */
export type Assets3d = Partial<Record<"vue" | "joueurs", AssetSet>>;
