// Harnais de bout en bout sans TeamSpeak : deux voix synthétiques + messages GSI d'une courte map (deux rounds)
// → session sur le disque (Recorder, comme la DLL), puis envoi facultatif (upload_session, comme la DLL).
// Usage : sightline_fake_session <dossier> [<adresse de Sightline> <clé sl_…>]
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

#include "core/gsi.h"
#include "core/recorder.h"
#include "gsi_json.h"
#include "win/clock.h"
#include "win/upload.h"

namespace fs = std::filesystem;

int main(int argc, char** argv) {
  if (argc != 2 && argc != 4) {
    std::fprintf(stderr, "usage : sightline_fake_session <dossier> [<adresse> <clé>]\n");
    return 2;
  }
  constexpr int64_t S = 1000000;
  const fs::path root = fs::path(argv[1]) / "sessions";
  const int64_t base = sl::win::now_us() - 30 * S;  // la « map » a commencé il y a 30 s
  sl::Recorder rec({root, SIGHTLINE_VERSION, 24000});
  rec.ts_connection(true, base);
  auto gsi = [&](double at, const char* map_phase, const char* round_phase, int round, int ct, int t) {
    sl::GsiState s;
    sl::parse_gsi(testgsi::map("harnais", map_phase, round_phase, round, ct, t), s);
    return rec.gsi(s, base + static_cast<int64_t>(at * S));
  };
  auto talk = [&](const char* uid, const char* nick, bool self, double from, double to, double hz) {
    std::vector<int16_t> pcm(960);
    for (int k = 0; from + k * 0.02 < to - 1e-9; ++k) {
      for (int i = 0; i < 960; ++i)
        pcm[i] = static_cast<int16_t>(8000 * std::sin(2 * 3.14159265358979 * hz * (k * 960 + i) / 48000.0));
      rec.voice(uid, nick, self, base + static_cast<int64_t>((from + k * 0.02) * S), pcm.data(), pcm.size());
    }
  };
  bool ok = gsi(0.0, "warmup", "warmup", 0, 0, 0) == sl::Change::Started;
  gsi(0.5, "live", "freezetime", 0, 0, 0);
  gsi(1.0, "live", "live", 0, 0, 0);  // round 1 : 1,0 s après A0
  talk("uid-a=", "sk1zy", true, 1.0, 3.0, 440);
  gsi(4.0, "live", "over", 0, 1, 0);
  gsi(4.5, "live", "freezetime", 1, 1, 0);
  gsi(5.0, "live", "live", 1, 1, 0);  // round 2 : 5,0 s
  talk("uid-b=", "Invité", false, 5.0, 7.0, 660);
  gsi(9.0, "live", "over", 1, 1, 1);
  talk("uid-a=", "sk1zy", true, 10.0, 12.0, 440);
  ok = gsi(13.0, "gameover", "over", 2, 1, 1) == sl::Change::Stopped && ok;
  const std::vector<fs::path> done = rec.take_finished();
  if (!ok || done.size() != 1) {
    std::fprintf(stderr, "session non produite : %s\n", rec.take_error().c_str());
    return 1;
  }
  std::printf("session : %s\n", done[0].u8string().c_str());
  if (argc == 2) return 0;
  const sl::win::UploadResult r = sl::win::upload_session(done[0], argv[2], argv[3], sl::win::now_us());
  std::printf("envoi : %d %s\n", r.status, r.message.c_str());
  return r.outcome == sl::win::Outcome::Sent ? 0 : 1;
}
