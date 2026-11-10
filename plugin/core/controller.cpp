#include "core/controller.h"

#include <algorithm>

namespace sl {
bool Controller::playing(const std::string& p) { return p == "warmup" || p == "live" || p == "intermission"; }

void Controller::start(int64_t now, const std::string& map) {
  rec_ = true;
  start_us_ = now;
  menu_since_ = 0;
  meta_ = SessionMeta{};
  meta_.map = map;
  meta_.recorder_steamid = last_steamid_;
}

Change Controller::stop(int64_t now) {
  if (!rec_) return Change::None;
  rec_ = false;
  ended_ = Ended{start_us_, now, meta_};
  return Change::Stopped;
}

std::optional<Ended> Controller::take_ended() {
  std::optional<Ended> e = std::move(ended_);
  ended_.reset();
  return e;
}

Change Controller::gsi(const GsiState& s, int64_t now) {
  Change c = Change::None;
  const std::string map = s.has_map ? clean_map(s.map) : "";
  if (!s.steamid.empty()) last_steamid_ = s.steamid;
  if (rec_ && s.has_map && meta_.map.empty()) meta_.map = map;  // départ à la main avant la map : on l'adopte
  if (rec_ && s.has_map && map != meta_.map) c = stop(now);      // autre map sans gameover
  if (!suppressed_.empty() && (!s.has_map || map != suppressed_ || s.map_phase == "gameover")) suppressed_.clear();
  if (!rec_ && ts_ && s.has_map && playing(s.map_phase) && map != suppressed_) {
    start(now, map);
    c = c == Change::Stopped ? Change::Restarted : Change::Started;
  }
  if (rec_) {
    if (!s.steamid.empty()) meta_.recorder_steamid = s.steamid;
    if (s.has_map) {
      menu_since_ = 0;
      // Début de round : fin du freezetime. map.round compte les rounds déjà joués → n = map.round + 1.
      if (prev_round_ == "freezetime" && s.round_phase == "live" && s.map_phase != "warmup" && s.map_round >= 0) {
        const int n = s.map_round + 1;
        auto& r = meta_.rounds;  // restart ou sauvegarde rechargée : n et les suivants sont rejoués
        r.erase(std::remove_if(r.begin(), r.end(), [n](const RoundMark& m) { return m.n >= n; }), r.end());
        r.push_back({n, now, 0});
      }
      if (prev_round_ != "over" && s.round_phase == "over" && !meta_.rounds.empty() &&
          meta_.rounds.back().over_us == 0)
        meta_.rounds.back().over_us = now;
      if (s.map_phase == "gameover") {
        if (s.score_ct >= 0 && s.score_t >= 0) meta_.score = std::array<int, 2>{s.score_ct, s.score_t};
        c = stop(now);
      }
    } else if (menu_since_ == 0) {
      menu_since_ = now;
    } else if (now - menu_since_ >= kMenuTimeoutUs) {
      c = stop(now);
    }
  }
  prev_round_ = s.has_map ? s.round_phase : "";
  last_ = s;
  last_gsi_us_ = now;
  return c;
}

Change Controller::ts_connection(bool connected, int64_t now) {
  ts_ = connected;
  if (!connected) return stop(now);
  if (!rec_ && last_.has_map && playing(last_.map_phase) && now - last_gsi_us_ <= kGsiFreshUs &&
      clean_map(last_.map) != suppressed_) {
    start(now, clean_map(last_.map));
    return Change::Started;
  }
  return Change::None;
}

Change Controller::tick(int64_t now) {
  if (rec_ && !meta_.map.empty() && now - last_gsi_us_ >= kMenuTimeoutUs) return stop(now);
  return Change::None;
}

Change Controller::manual(int64_t now) {
  if (rec_) {
    suppressed_ = meta_.map;
    return stop(now);
  }
  if (!ts_) return Change::None;
  const bool in_map = last_.has_map && now - last_gsi_us_ <= kGsiFreshUs;
  suppressed_.clear();
  start(now, in_map ? clean_map(last_.map) : "");
  return Change::Started;
}
}  // namespace sl
