// Le cœur du plugin, sans fil ni TeamSpeak : décisions du contrôleur + session en cours sur le disque.
// La DLL l'appelle sous un verrou (fils GSI, TeamSpeak et encodage) ; le harnais l'appelle directement.
#pragma once
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include "core/controller.h"
#include "core/session.h"
#include "core/version.h"

namespace sl {
struct RecorderConfig {
  std::filesystem::path sessions_root;  // …\plugins\sightline\sessions
  std::string plugin_version = SIGHTLINE_VERSION;
  int bitrate_bps = 24000;
};

class Recorder {
 public:
  explicit Recorder(RecorderConfig cfg) : cfg_(std::move(cfg)) {}
  Change gsi(const GsiState& s, int64_t now_us) { return apply(ctl_.gsi(s, now_us)); }
  Change ts_connection(bool connected, int64_t now_us) { return apply(ctl_.ts_connection(connected, now_us)); }
  Change tick(int64_t now_us) { return apply(ctl_.tick(now_us)); }  // CS2 muet depuis 2 min : fin de session
  Change manual(int64_t now_us) { return apply(ctl_.manual(now_us)); }
  void voice(const std::string& uid, const std::string& nickname, bool self, int64_t wall_us, const int16_t* pcm,
             size_t n);
  bool recording() const { return session_ != nullptr; }
  const Controller& controller() const { return ctl_; }
  std::vector<std::filesystem::path> take_finished();  // sessions complètes (session.json écrit), à envoyer
  std::string take_error();                             // dernier problème, pour le journal

 private:
  Change apply(Change c);
  void open_session();
  void finish_session(const Ended& e);
  RecorderConfig cfg_;
  Controller ctl_;
  std::unique_ptr<Session> session_;
  std::vector<std::filesystem::path> finished_;
  std::string error_;
  bool refused_logged_ = false;
};
}  // namespace sl
