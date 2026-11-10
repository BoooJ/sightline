// Game State Integration de CS2 : ce que le plugin lit des messages envoyés par le jeu.
#pragma once
#include <string>

namespace sl {
struct GsiState {
  std::string token;        // auth.token : doit valoir celui du fichier .cfg installé par le plugin
  std::string steamid;      // provider.steamid : le joueur de ce PC (l'enregistreur)
  bool has_map = false;     // pas de bloc map au menu principal
  std::string map;          // map.name, ex. "de_mirage"
  std::string map_phase;    // warmup / live / intermission / gameover
  int map_round = -1;       // map.round : rounds déjà joués (0 pendant le premier)
  int score_ct = -1, score_t = -1;
  std::string round_phase;  // freezetime / live / over
};
// false si le texte n'est pas un objet JSON
bool parse_gsi(const std::string& body, GsiState& out);
// Nom de carte accepté par Sightline ([a-z0-9_], 2 à 64) : "workshop/123/de_x" → "de_x" ; sinon "inconnue"
std::string clean_map(const std::string& name);
}  // namespace sl
