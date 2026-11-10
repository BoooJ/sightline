#include "core/session.h"

#include <cctype>
#include <fstream>

#include "core/gsi.h"
#include "core/json.h"
#include "core/timeutil.h"

namespace fs = std::filesystem;

namespace sl {
Session::Session(fs::path dir, int64_t a0_us, int bitrate_bps) : dir_(std::move(dir)), a0_(a0_us), bitrate_(bitrate_bps) {}

bool Session::open() {
  std::error_code ec;
  fs::create_directories(dir_, ec);
  return fs::is_directory(dir_, ec);
}

int64_t Session::samples_at(int64_t wall_us) const {
  const int64_t d = wall_us - a0_;
  return d <= 0 ? 0 : d * 48 / 1000;
}

bool Session::voice(const std::string& uid, const std::string& nickname, bool self, int64_t wall_us,
                    const int16_t* pcm, size_t n) {
  Track* t = nullptr;
  for (Track& x : tracks_)
    if (x.info.uid == uid) {
      t = &x;
      break;
    }
  if (!t) {
    if (tracks_.size() >= kMaxTracks) return false;
    Track nt;
    nt.info = {"t" + std::to_string(tracks_.size() + 1) + ".ogg", uid, nickname, self};
    nt.enc = std::make_unique<OpusTrack>();
    if (!nt.enc->open(dir_ / nt.info.file, 0x51670000u + static_cast<uint32_t>(tracks_.size()), bitrate_))
      return false;
    tracks_.push_back(std::move(nt));
    t = &tracks_.back();
  }
  const int64_t at = samples_at(wall_us);
  const int64_t pos = static_cast<int64_t>(t->enc->position());
  if (at > pos + kGapSamples) t->enc->silence(static_cast<uint64_t>(at - pos));
  t->enc->write(pcm, n);
  return true;
}

std::vector<TrackInfo> Session::tracks() const {
  std::vector<TrackInfo> out;
  for (const Track& t : tracks_) out.push_back(t.info);
  return out;
}

bool Session::finish(int64_t end_us, const SessionMeta& meta, const std::string& plugin_version) {
  bool ok = true;
  const int64_t end = samples_at(end_us);
  for (Track& t : tracks_) {
    const int64_t pos = static_cast<int64_t>(t.enc->position());
    if (end > pos) t.enc->silence(static_cast<uint64_t>(end - pos));
    ok = t.enc->close() && ok;
  }
  if (!ok || tracks_.empty()) return ok;
  const fs::path part = dir_ / "session.json.part";
  {
    std::ofstream f(part, std::ios::binary | std::ios::trunc);
    f << session_json(plugin_version, a0_, meta, tracks());
    f.close();
    if (f.fail()) return false;
  }
  std::error_code ec;
  fs::rename(part, dir_ / "session.json", ec);  // une session sans session.json n'est jamais envoyée
  return !ec;
}

std::string session_json(const std::string& plugin_version, int64_t a0_us, const SessionMeta& m,
                         const std::vector<TrackInfo>& tracks) {
  bool digits = !m.recorder_steamid.empty();
  for (const unsigned char c : m.recorder_steamid) digits = digits && std::isdigit(c);
  std::string s = "{\"plugin\":" + json::quote(plugin_version);
  s += ",\"recorder_steamid\":" + (digits ? json::quote(m.recorder_steamid) : std::string("null"));
  s += ",\"started_at\":" + json::quote(iso_utc_ms(a0_us));
  s += ",\"map\":" + json::quote(clean_map(m.map));
  s += ",\"score\":" + (m.score ? "[" + std::to_string((*m.score)[0]) + "," + std::to_string((*m.score)[1]) + "]"
                                : std::string("null"));
  s += ",\"rounds\":[";
  for (size_t i = 0; i < m.rounds.size(); ++i) {
    const RoundMark& r = m.rounds[i];
    if (i) s += ",";
    s += "{\"n\":" + std::to_string(r.n) + ",\"live_at\":" + json::quote(iso_utc_ms(r.live_us)) +
         ",\"over_at\":" + (r.over_us ? json::quote(iso_utc_ms(r.over_us)) : std::string("null")) + "}";
  }
  s += "],\"tracks\":[";
  for (size_t i = 0; i < tracks.size(); ++i) {
    if (i) s += ",";
    s += "{\"file\":" + json::quote(tracks[i].file) + ",\"ts_uid\":" + json::quote(tracks[i].uid) +
         ",\"ts_nickname\":" + json::quote(tracks[i].nickname) + ",\"self\":" + (tracks[i].self ? "true" : "false") +
         "}";
  }
  return s + "]}";
}
}  // namespace sl
