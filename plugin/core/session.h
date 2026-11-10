// Une session : une piste Opus par identifiant TeamSpeak, toutes calées sur A0 (début de l'enregistrement).
#pragma once
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include "core/controller.h"
#include "core/opus_track.h"

namespace sl {
struct TrackInfo {
  std::string file, uid, nickname;
  bool self = false;
};
constexpr size_t kMaxTracks = 12;     // limite de Sightline
constexpr int64_t kGapSamples = 960;  // retard toléré (20 ms) avant de combler par du silence

class Session {
 public:
  Session(std::filesystem::path dir, int64_t a0_us, int bitrate_bps = 24000);
  bool open();  // crée le dossier
  // Bloc de voix (48 kHz mono) reçu à l'heure murale `wall_us`. false : piste refusée (12 déjà) ou fichier impossible.
  bool voice(const std::string& uid, const std::string& nickname, bool self, int64_t wall_us, const int16_t* pcm,
             size_t n);
  // Comble chaque piste jusqu'à `end_us`, ferme les fichiers, écrit session.json (via un .part renommé).
  bool finish(int64_t end_us, const SessionMeta& meta, const std::string& plugin_version);
  const std::filesystem::path& dir() const { return dir_; }
  size_t track_count() const { return tracks_.size(); }
  std::vector<TrackInfo> tracks() const;
  int64_t a0_us() const { return a0_; }

 private:
  struct Track {
    TrackInfo info;
    std::unique_ptr<OpusTrack> enc;
  };
  int64_t samples_at(int64_t wall_us) const;
  std::filesystem::path dir_;
  int64_t a0_;
  int bitrate_;
  std::vector<Track> tracks_;
};

// session.json attendu par Sightline (POST /api/integrations/comms, cf. comms.clean_session)
std::string session_json(const std::string& plugin_version, int64_t a0_us, const SessionMeta& meta,
                         const std::vector<TrackInfo>& tracks);
}  // namespace sl
