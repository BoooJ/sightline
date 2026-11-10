// Quand enregistrer, et les débuts/fins de rounds, d'après la GSI de CS2 et la connexion TeamSpeak.
// Aucune horloge ici : chaque appel reçoit l'heure murale (µs UTC) du moment de l'événement.
#pragma once
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "core/gsi.h"

namespace sl {
struct RoundMark {
  int n = 0;            // numéro Sightline (1 = premier round)
  int64_t live_us = 0;  // fin du freezetime
  int64_t over_us = 0;  // fin du round (0 : pas encore fini)
};
struct SessionMeta {
  std::string recorder_steamid;            // provider.steamid ("" : inconnu)
  std::string map;                         // carte nettoyée ("" : inconnue)
  std::optional<std::array<int, 2>> score; // [CT, T], seulement si la map est allée jusqu'au gameover
  std::vector<RoundMark> rounds;
};
struct Ended {
  int64_t start_us = 0, end_us = 0;
  SessionMeta meta;
};
enum class Change { None, Started, Stopped, Restarted };

class Controller {
 public:
  static constexpr int64_t kMenuTimeoutUs = 120LL * 1000000;  // 2 min au menu principal : fin de la session
  static constexpr int64_t kGsiFreshUs = 60LL * 1000000;      // dernier message GSI assez récent pour démarrer
  Change gsi(const GsiState& s, int64_t now_us);
  Change ts_connection(bool connected, int64_t now_us);
  // À appeler régulièrement : si CS2 s'est tu (fermé ou planté sans gameover) depuis 2 min alors que la session
  // est liée à une map, elle se termine. Un départ à la main sans aucune GSI n'est jamais arrêté ici.
  Change tick(int64_t now_us);
  Change manual(int64_t now_us);  // menu « Enregistrer maintenant / Arrêter »
  bool recording() const { return rec_; }
  bool ts_connected() const { return ts_; }
  int64_t started_us() const { return start_us_; }
  const SessionMeta& meta() const { return meta_; }
  std::optional<Ended> take_ended();  // la session qui vient de s'arrêter (rendue une seule fois)

 private:
  static bool playing(const std::string& map_phase);
  void start(int64_t now_us, const std::string& map);
  Change stop(int64_t now_us);
  bool rec_ = false, ts_ = false;
  int64_t start_us_ = 0, menu_since_ = 0, last_gsi_us_ = 0;
  SessionMeta meta_;
  std::optional<Ended> ended_;
  GsiState last_;
  std::string prev_round_;  // round.phase du message précédent
  std::string suppressed_;  // carte arrêtée à la main : pas de reprise auto avant le gameover ou une autre map
  std::string last_steamid_;
};
}  // namespace sl
