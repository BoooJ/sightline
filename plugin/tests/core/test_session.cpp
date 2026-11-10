#include <filesystem>
#include <fstream>
#include <iterator>

#include "check.h"
#include "core/json.h"
#include "core/recorder.h"
#include "core/session.h"
#include "core/timeutil.h"
#include "gsi_json.h"
#include "ogg_read.h"

namespace fs = std::filesystem;

namespace {
constexpr int64_t S = 1000000;
constexpr int64_t A0 = 1792870201123000;  // 2026-10-24T19:30:01.123Z

std::string read_text(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}
// Voix synthétique en blocs de 20 ms, horodatés comme les rappels de TeamSpeak
template <class Sink>
void talk(Sink&& sink, int64_t from_us, double seconds, double hz) {
  const int blocks = static_cast<int>(seconds * 50 + 0.5);
  for (int k = 0; k < blocks; ++k) {
    const std::vector<int16_t> pcm = testogg::sine(960, hz, static_cast<size_t>(k) * 960);
    sink(from_us + k * 20000LL, pcm.data(), pcm.size());
  }
}
sl::GsiState G(const char* map_phase, const char* round_phase, int round, int ct = 0, int t = 0,
               const char* map = "de_nuke") {
  sl::GsiState s;
  sl::parse_gsi(testgsi::map("x", map_phase, round_phase, round, ct, t, map), s);
  return s;
}
}  // namespace

TEST(session_aligns_tracks_on_a0_and_writes_session_json) {
  const fs::path dir = check::temp_dir("session") / "20261024-193001";
  sl::Session s(dir, A0);
  CHECK(s.open());
  talk([&](int64_t w, const int16_t* p, size_t n) { CHECK(s.voice("uid-a=", "sk1zy", true, w, p, n)); }, A0 + S / 2,
       0.3, 440);
  talk([&](int64_t w, const int16_t* p, size_t n) { CHECK(s.voice("uid-b=", "Invité", false, w, p, n)); },
       A0 + 2 * S, 0.5, 660);
  sl::SessionMeta meta;
  meta.recorder_steamid = "76561198000000001";
  meta.map = "de_mirage";
  meta.score = std::array<int, 2>{13, 9};
  meta.rounds = {{1, A0 + 1 * S, A0 + 3 * S}, {2, A0 + 3 * S + S / 2, 0}};
  CHECK(s.finish(A0 + 4 * S, meta, "1.0.0"));
  CHECK_EQ(read_text(dir / "session.json"),
           std::string("{\"plugin\":\"1.0.0\",\"recorder_steamid\":\"76561198000000001\","
                       "\"started_at\":\"2026-10-24T19:30:01.123Z\",\"map\":\"de_mirage\",\"score\":[13,9],"
                       "\"rounds\":[{\"n\":1,\"live_at\":\"2026-10-24T19:30:02.123Z\","
                       "\"over_at\":\"2026-10-24T19:30:04.123Z\"},{\"n\":2,"
                       "\"live_at\":\"2026-10-24T19:30:04.623Z\",\"over_at\":null}],"
                       "\"tracks\":[{\"file\":\"t1.ogg\",\"ts_uid\":\"uid-a=\",\"ts_nickname\":\"sk1zy\",\"self\":true},"
                       "{\"file\":\"t2.ogg\",\"ts_uid\":\"uid-b=\",\"ts_nickname\":\"Invité\",\"self\":false}]}"));
  CHECK(!fs::exists(dir / "session.json.part"));
  const std::vector<int16_t> a = testogg::decode(testogg::read_ogg(dir / "t1.ogg"));
  const std::vector<int16_t> b = testogg::decode(testogg::read_ogg(dir / "t2.ogg"));
  CHECK_EQ(a.size(), size_t(4 * 48000));  // même durée : de A0 à la fin
  CHECK_EQ(b.size(), size_t(4 * 48000));
  CHECK(testogg::rms(a, 0.0, 0.45) < 50);
  CHECK(testogg::rms(a, 0.52, 0.78) > 2000);
  CHECK(testogg::rms(a, 0.9, 4.0) < 200);
  CHECK(testogg::peak(a, 1.35, 4.0) < 500);
  CHECK(testogg::rms(b, 0.0, 1.95) < 50);
  CHECK(testogg::rms(b, 2.03, 2.47) > 2000);
  CHECK(testogg::rms(b, 2.6, 4.0) < 200);
  CHECK(testogg::peak(b, 3.05, 4.0) < 500);
}

TEST(session_caps_tracks_at_twelve) {
  const fs::path dir = check::temp_dir("session12");
  sl::Session s(dir, A0);
  CHECK(s.open());
  const std::vector<int16_t> pcm = testogg::sine(960, 440);
  for (int i = 1; i <= 12; ++i) CHECK(s.voice("uid-" + std::to_string(i), "j", false, A0, pcm.data(), pcm.size()));
  CHECK(!s.voice("uid-13", "j", false, A0, pcm.data(), pcm.size()));
  CHECK(s.voice("uid-3", "j", false, A0 + 20000, pcm.data(), pcm.size()));  // piste déjà ouverte : acceptée
  CHECK_EQ(s.track_count(), size_t(12));
  CHECK(s.finish(A0 + S, sl::SessionMeta{}, "1.0.0"));
}

TEST(session_json_nulls_and_unknown_map) {
  sl::SessionMeta meta;
  meta.recorder_steamid = "abc";  // pas un SteamID : null (le serveur refuserait la session)
  const std::string j = sl::session_json("1.0.0", 0, meta, {{"t1.ogg", "u", "n", false}});
  CHECK_EQ(j, std::string("{\"plugin\":\"1.0.0\",\"recorder_steamid\":null,\"started_at\":\"1970-01-01T00:00:00.000Z\","
                          "\"map\":\"inconnue\",\"score\":null,\"rounds\":[],"
                          "\"tracks\":[{\"file\":\"t1.ogg\",\"ts_uid\":\"u\",\"ts_nickname\":\"n\",\"self\":false}]}"));
  sl::json::Value v;
  CHECK(sl::json::parse(j, v));
}

TEST(session_ignores_small_jitter) {
  const fs::path dir = check::temp_dir("jitter");
  sl::Session s(dir, 0);
  CHECK(s.open());
  for (int k = 0; k < 50; ++k) {
    const int64_t jitter = k == 0 ? 0 : (k % 2 ? 5000 : -5000);
    const std::vector<int16_t> pcm = testogg::sine(960, 440, static_cast<size_t>(k) * 960);
    s.voice("u", "n", false, k * 20000LL + jitter, pcm.data(), pcm.size());
  }
  CHECK(s.finish(S, sl::SessionMeta{}, "1.0.0"));
  const std::vector<int16_t> pcm = testogg::decode(testogg::read_ogg(dir / "t1.ogg"));
  CHECK_EQ(pcm.size(), size_t(48000));  // aucun silence ajouté au milieu de la voix
  CHECK(testogg::rms(pcm, 0.05, 0.95) > 2000);
}

TEST(recorder_writes_one_session_per_map) {
  const fs::path root = check::temp_dir("recorder");
  sl::Recorder r({root, "1.0.0", 24000});
  const int16_t early[960] = {};
  r.voice("u", "n", false, A0, early, 960);  // pas d'enregistrement : ignoré
  r.ts_connection(true, A0 - S);
  CHECK(r.gsi(G("warmup", "warmup", 0), A0) == sl::Change::Started);
  CHECK(r.recording());
  r.gsi(G("live", "freezetime", 0), A0 + S / 2);
  r.gsi(G("live", "live", 0), A0 + S);
  talk([&](int64_t w, const int16_t* p, size_t n) { r.voice("uid-a=", "sk1zy", true, w, p, n); }, A0 + S, 0.2, 440);
  r.gsi(G("live", "over", 0, 1, 0), A0 + 2 * S);
  talk([&](int64_t w, const int16_t* p, size_t n) { r.voice("uid-b=", "Invité", false, w, p, n); }, A0 + 5 * S / 2,
       0.2, 660);
  CHECK(r.gsi(G("gameover", "over", 1, 1, 0), A0 + 3 * S) == sl::Change::Stopped);
  CHECK(!r.recording());
  const auto done = r.take_finished();
  CHECK_EQ(done.size(), size_t(1));
  if (done.size() != 1) return;
  CHECK_EQ(done[0].filename().u8string(), std::string("20261024-193001"));
  CHECK(fs::exists(done[0] / "t1.ogg") && fs::exists(done[0] / "t2.ogg"));
  sl::json::Value v;
  CHECK(sl::json::parse(read_text(done[0] / "session.json"), v));
  CHECK_EQ(v.string_or("started_at"), sl::iso_utc_ms(A0));
  CHECK_EQ(v.string_or("map"), std::string("de_nuke"));
  CHECK_EQ(v.get("rounds")->arr.size(), size_t(1));
  CHECK_EQ(v.get("rounds")->arr[0].number_or("n", 0), 1.0);
  CHECK_EQ(v.get("score")->arr.size(), size_t(2));
  CHECK_EQ(v.get("tracks")->arr.size(), size_t(2));
  CHECK(r.take_finished().empty());
  CHECK(r.take_error().empty());
}

TEST(recorder_drops_silent_sessions_and_numbers_folders) {
  const fs::path root = check::temp_dir("recorder2");
  sl::Recorder r({root, "1.0.0", 24000});
  r.ts_connection(true, A0);
  CHECK(r.gsi(G("live", "live", 0), A0) == sl::Change::Started);
  CHECK(r.gsi(G("gameover", "over", 1, 1, 0), A0 + S) == sl::Change::Stopped);  // personne n'a parlé
  CHECK(r.take_finished().empty());
  CHECK(fs::is_empty(root));
  const std::vector<int16_t> pcm = testogg::sine(960, 440);
  const int64_t t0 = A0 + 10 * S;  // 19:30:11.123
  CHECK(r.gsi(G("warmup", "warmup", 0), t0) == sl::Change::Started);
  r.voice("u", "n", false, t0, pcm.data(), pcm.size());
  CHECK(r.gsi(G("warmup", "warmup", 0, 0, 0, "de_mirage"), t0 + S / 4) == sl::Change::Restarted);  // même seconde
  r.voice("u", "n", false, t0 + S / 4, pcm.data(), pcm.size());
  CHECK(r.gsi(G("gameover", "over", 1, 1, 0, "de_mirage"), t0 + S / 2) == sl::Change::Stopped);
  const auto done = r.take_finished();
  CHECK_EQ(done.size(), size_t(2));
  if (done.size() == 2) {
    CHECK_EQ(done[0].filename().u8string(), std::string("20261024-193011"));
    CHECK_EQ(done[1].filename().u8string(), std::string("20261024-193011-2"));
  }
}

TEST(recorder_tick_ends_a_map_session_when_the_gsi_goes_silent) {
  const fs::path root = check::temp_dir("recorder_tick");
  sl::Recorder r({root, "1.0.0", 24000});
  r.ts_connection(true, A0 - S);
  CHECK(r.gsi(G("live", "live", 0), A0) == sl::Change::Started);
  const int64_t last_gsi = A0 + S;
  r.gsi(G("live", "live", 0), last_gsi);
  talk([&](int64_t w, const int16_t* p, size_t n) { r.voice("uid-a=", "sk1zy", true, w, p, n); }, A0 + S / 2, 0.2, 440);
  CHECK(r.tick(last_gsi + sl::Controller::kMenuTimeoutUs - 1) == sl::Change::None);  // pas encore
  CHECK(r.recording());
  CHECK(r.tick(last_gsi + sl::Controller::kMenuTimeoutUs) == sl::Change::Stopped);
  CHECK(!r.recording());
  const auto done = r.take_finished();
  CHECK_EQ(done.size(), size_t(1));
  if (done.size() != 1) return;
  CHECK(fs::exists(done[0] / "session.json"));
  CHECK(fs::exists(done[0] / "t1.ogg"));
  CHECK(r.take_error().empty());
}
