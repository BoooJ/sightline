// Messages GSI de CS2 (forme réelle, réduite aux blocs demandés par le plugin) pour les tests et le harnais.
#pragma once
#include <string>

namespace testgsi {
inline std::string map(const std::string& token, const std::string& map_phase, const std::string& round_phase,
                       int round, int ct, int t, const std::string& name = "de_nuke") {
  return "{\"provider\":{\"name\":\"Counter-Strike: Global Offensive\",\"appid\":730,\"version\":14090,"
         "\"steamid\":\"76561198000000001\",\"timestamp\":1792870201},"
         "\"map\":{\"mode\":\"competitive\",\"name\":\"" + name + "\",\"phase\":\"" + map_phase +
         "\",\"round\":" + std::to_string(round) + ",\"team_ct\":{\"score\":" + std::to_string(ct) +
         ",\"consecutive_round_losses\":0,\"timeouts_remaining\":1,\"matches_won_this_series\":0},"
         "\"team_t\":{\"score\":" + std::to_string(t) +
         ",\"consecutive_round_losses\":1,\"timeouts_remaining\":1,\"matches_won_this_series\":0},"
         "\"num_matches_to_win_series\":0},\"round\":{\"phase\":\"" + round_phase + "\"},"
         "\"auth\":{\"token\":\"" + token + "\"}}";
}
// Au menu principal : pas de bloc map ni round
inline std::string menu(const std::string& token) {
  return "{\"provider\":{\"name\":\"Counter-Strike: Global Offensive\",\"appid\":730,"
         "\"steamid\":\"76561198000000001\"},\"auth\":{\"token\":\"" + token + "\"}}";
}
}  // namespace testgsi
