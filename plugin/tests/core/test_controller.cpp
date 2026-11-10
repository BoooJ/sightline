#include "check.h"
#include "core/controller.h"
#include "gsi_json.h"

namespace {
constexpr int64_t S = 1000000;
sl::GsiState G(const char* map_phase, const char* round_phase, int round, int ct = 0, int t = 0,
               const char* map = "de_nuke") {
  sl::GsiState s;
  sl::parse_gsi(testgsi::map("x", map_phase, round_phase, round, ct, t, map), s);
  return s;
}
sl::GsiState M() {
  sl::GsiState s;
  sl::parse_gsi(testgsi::menu("x"), s);
  return s;
}
}  // namespace

TEST(controller_starts_only_with_teamspeak) {
  sl::Controller c;
  CHECK(c.gsi(G("warmup", "warmup", 0), 1 * S) == sl::Change::None);  // TeamSpeak pas connecté
  CHECK(c.ts_connection(true, 2 * S) == sl::Change::Started);          // map récente : départ
  CHECK(c.recording());
  CHECK_EQ(c.started_us(), 2 * S);
  CHECK_EQ(c.meta().map, std::string("de_nuke"));
  CHECK_EQ(c.meta().recorder_steamid, std::string("76561198000000001"));
  sl::Controller d;
  d.gsi(G("warmup", "warmup", 0), 1 * S);
  CHECK(d.ts_connection(true, 100 * S) == sl::Change::None);  // GSI trop ancienne : CS2 n'est plus en map
}

TEST(controller_full_map_rounds_and_score) {
  sl::Controller c;
  c.ts_connection(true, 0);
  CHECK(c.gsi(G("warmup", "warmup", 0), 1 * S) == sl::Change::Started);
  c.gsi(G("live", "freezetime", 0), 2 * S);
  c.gsi(G("live", "live", 0), 3 * S);  // map.round = 0 → round 1
  c.gsi(G("live", "over", 0, 1, 0), 4 * S);
  c.gsi(G("live", "freezetime", 1, 1, 0), 5 * S);
  c.gsi(G("live", "live", 1, 1, 0), 6 * S);
  c.gsi(G("live", "over", 1, 1, 1), 7 * S);
  CHECK(c.gsi(G("gameover", "over", 2, 1, 1), 8 * S) == sl::Change::Stopped);
  CHECK(!c.recording());
  const auto e = c.take_ended();
  CHECK(e.has_value());
  if (!e) return;
  CHECK_EQ(e->start_us, 1 * S);
  CHECK_EQ(e->end_us, 8 * S);
  CHECK(e->meta.score == (std::array<int, 2>{1, 1}));
  CHECK_EQ(e->meta.rounds.size(), size_t(2));
  if (e->meta.rounds.size() == 2) {
    CHECK_EQ(e->meta.rounds[0].n, 1);
    CHECK_EQ(e->meta.rounds[0].live_us, 3 * S);
    CHECK_EQ(e->meta.rounds[0].over_us, 4 * S);
    CHECK_EQ(e->meta.rounds[1].n, 2);
    CHECK_EQ(e->meta.rounds[1].live_us, 6 * S);
    CHECK_EQ(e->meta.rounds[1].over_us, 7 * S);
  }
  CHECK(!c.take_ended());  // une seule fois
}

TEST(controller_ignores_warmup_rounds_and_handles_restarts) {
  sl::Controller c;
  c.ts_connection(true, 0);
  CHECK(c.gsi(G("warmup", "freezetime", 0), 1 * S) == sl::Change::Started);
  c.gsi(G("warmup", "live", 0), 2 * S);  // round d'échauffement : ignoré
  CHECK(c.meta().rounds.empty());
  c.gsi(G("live", "freezetime", 0), 3 * S);
  c.gsi(G("live", "live", 0), 4 * S);
  c.gsi(G("live", "over", 0, 1, 0), 5 * S);
  c.gsi(G("live", "freezetime", 1, 1, 0), 6 * S);
  c.gsi(G("live", "live", 1, 1, 0), 7 * S);
  CHECK_EQ(c.meta().rounds.size(), size_t(2));
  c.gsi(G("live", "freezetime", 0), 8 * S);  // mp_restartgame : on repart du round 1
  c.gsi(G("live", "live", 0), 9 * S);
  CHECK_EQ(c.meta().rounds.size(), size_t(1));
  if (!c.meta().rounds.empty()) {
    CHECK_EQ(c.meta().rounds[0].live_us, 9 * S);
    CHECK_EQ(c.meta().rounds[0].over_us, int64_t(0));
  }
}

TEST(controller_map_change_restarts) {
  sl::Controller c;
  c.ts_connection(true, 0);
  CHECK(c.gsi(G("live", "live", 0), 1 * S) == sl::Change::Started);
  CHECK(c.gsi(G("warmup", "warmup", 0, 0, 0, "de_mirage"), 2 * S) == sl::Change::Restarted);
  const auto e = c.take_ended();
  CHECK(e && e->meta.map == "de_nuke" && e->end_us == 2 * S);
  CHECK_EQ(c.meta().map, std::string("de_mirage"));
  CHECK_EQ(c.started_us(), 2 * S);
}

TEST(controller_manual_stop_waits_for_the_next_map) {
  sl::Controller c;
  c.ts_connection(true, 0);
  CHECK(c.gsi(G("live", "live", 3), 1 * S) == sl::Change::Started);
  CHECK(c.manual(2 * S) == sl::Change::Stopped);
  CHECK(c.gsi(G("live", "over", 3), 3 * S) == sl::Change::None);  // même map : pas de reprise
  CHECK(c.gsi(G("gameover", "over", 4, 2, 2), 4 * S) == sl::Change::None);
  CHECK(c.gsi(G("warmup", "warmup", 0), 5 * S) == sl::Change::Started);  // map suivante (même nom)
}

TEST(controller_menu_timeout_and_disconnect) {
  sl::Controller c;
  c.ts_connection(true, 0);
  CHECK(c.gsi(G("live", "live", 0), 1 * S) == sl::Change::Started);
  CHECK(c.gsi(M(), 10 * S) == sl::Change::None);
  CHECK(c.gsi(M(), 100 * S) == sl::Change::None);
  CHECK(c.gsi(M(), 131 * S) == sl::Change::Stopped);  // 2 min au menu depuis 10 s
  sl::Controller d;
  d.ts_connection(true, 0);
  d.gsi(G("live", "live", 0), 1 * S);
  CHECK(d.ts_connection(false, 2 * S) == sl::Change::Stopped);
  CHECK(d.gsi(G("live", "freezetime", 1), 3 * S) == sl::Change::None);  // déconnecté : rien
  CHECK(!d.recording());
  CHECK(d.ts_connection(true, 4 * S) == sl::Change::Started);  // reconnexion pendant la map
}

TEST(controller_manual_start_without_cs2) {
  sl::Controller c;
  CHECK(c.manual(1 * S) == sl::Change::None);  // TeamSpeak pas connecté
  c.ts_connection(true, 2 * S);
  CHECK(c.manual(3 * S) == sl::Change::Started);
  CHECK_EQ(c.meta().map, std::string(""));
  CHECK(c.gsi(G("live", "freezetime", 0), 4 * S) == sl::Change::None);  // la map est adoptée
  CHECK_EQ(c.meta().map, std::string("de_nuke"));
  c.gsi(G("live", "live", 0), 5 * S);
  CHECK_EQ(c.meta().rounds.size(), size_t(1));
}

TEST(controller_tick_stops_when_cs2_goes_silent) {
  sl::Controller c;
  c.ts_connection(true, 0);
  CHECK(c.gsi(G("live", "live", 0), 1 * S) == sl::Change::Started);
  CHECK(c.tick(1 * S + sl::Controller::kMenuTimeoutUs - 1) == sl::Change::None);
  CHECK(c.recording());
  CHECK(c.tick(1 * S + sl::Controller::kMenuTimeoutUs) == sl::Change::Stopped);
  CHECK(!c.recording());
  const auto e = c.take_ended();
  CHECK(e && e->meta.map == "de_nuke" && e->end_us == 1 * S + sl::Controller::kMenuTimeoutUs);
  CHECK(c.tick(1000 * S) == sl::Change::None);  // déjà arrêtée
  // Comme après le délai au menu : aucune suppression, une GSI de map en cours relance l'enregistrement
  CHECK(c.gsi(G("live", "live", 2), 300 * S) == sl::Change::Started);
}

TEST(controller_tick_never_stops_a_manual_start_without_gsi) {
  sl::Controller c;
  c.ts_connection(true, 0);
  CHECK(c.manual(1 * S) == sl::Change::Started);
  CHECK(c.tick(100000 * S) == sl::Change::None);
  CHECK(c.recording());
}
