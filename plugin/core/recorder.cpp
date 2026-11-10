#include "core/recorder.h"

#include "core/timeutil.h"

namespace fs = std::filesystem;

namespace sl {
Change Recorder::apply(Change c) {
  if (auto e = ctl_.take_ended()) finish_session(*e);
  if (c == Change::Started || c == Change::Restarted) open_session();
  return c;
}

void Recorder::open_session() {
  const int64_t a0 = ctl_.started_us();
  const std::string stamp = folder_stamp(a0);
  fs::path dir = cfg_.sessions_root / stamp;
  std::error_code ec;
  for (int k = 2; fs::exists(dir, ec); ++k) dir = cfg_.sessions_root / (stamp + "-" + std::to_string(k));
  session_ = std::make_unique<Session>(dir, a0, cfg_.bitrate_bps);
  if (!session_->open()) {
    error_ = "dossier de session impossible : " + dir.u8string();
    session_.reset();
  }
  refused_logged_ = false;
}

void Recorder::finish_session(const Ended& e) {
  if (!session_) return;
  std::unique_ptr<Session> s = std::move(session_);
  if (s->track_count() == 0) {  // personne n'a parlé : rien à envoyer
    std::error_code ec;
    fs::remove_all(s->dir(), ec);
    return;
  }
  if (s->finish(e.end_us, e.meta, cfg_.plugin_version)) finished_.push_back(s->dir());
  else error_ = "écriture de la session impossible : " + s->dir().u8string();
}

void Recorder::voice(const std::string& uid, const std::string& nickname, bool self, int64_t wall_us,
                     const int16_t* pcm, size_t n) {
  if (!session_) return;
  if (!session_->voice(uid, nickname, self, wall_us, pcm, n) && !refused_logged_) {
    error_ = "piste refusée (12 pistes au plus, ou fichier impossible) : " + nickname;
    refused_logged_ = true;
  }
}

std::vector<fs::path> Recorder::take_finished() {
  std::vector<fs::path> v = std::move(finished_);
  finished_.clear();
  return v;
}

std::string Recorder::take_error() {
  std::string e = std::move(error_);
  error_.clear();
  return e;
}
}  // namespace sl
