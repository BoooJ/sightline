#include "ts3/app.h"

#include <chrono>
#include <vector>

#include "core/gsi.h"
#include "core/outbox.h"
#include "core/steam.h"
#include "core/version.h"
#include "teamspeak/public_errors.h"
#include "ts3/settings_dialog.h"
#include "win/clock.h"
#include "win/secret.h"
#include "win/steam_paths.h"
#include "win/upload.h"

namespace fs = std::filesystem;

namespace sl {
namespace {
const char* kStartText = "🔴 Comms enregistrées pour Sightline (map en cours)";
const char* kStopText = "⏹ Fin de l'enregistrement";
const char* kSettingsHint = " — Plugins › Sightline Comms › Réglages.";
constexpr int64_t kTickEveryUs = 1000000;  // contrôle du silence de CS2 : une fois par seconde
}  // namespace

int App::init() {
  char path[1024] = {};
  ts_.getConfigPath(path, sizeof path);
  dir_ = fs::u8path(path) / "plugins" / "sightline";  // %APPDATA%\TS3Client\plugins\sightline
  std::error_code ec;
  fs::create_directories(dir_ / "sessions", ec);
  if (ec) {
    log("dossier impossible : " + dir_.u8string(), LogLevel_ERROR);
    return 1;
  }
  {
    std::lock_guard<std::mutex> l(settings_mx_);
    settings_ = load_settings(dir_ / "settings.json");
    if (settings_.gsi_token.empty()) {
      settings_.gsi_token = random_hex(16);
      save_settings(dir_ / "settings.json", settings_);
    }
    token_ = settings_.gsi_token;
  }
  rec_ = std::make_unique<Recorder>(RecorderConfig{dir_ / "sessions", SIGHTLINE_VERSION, 24000});
  install_gsi();
  std::string err;
  if (!gsi_.start(settings().gsi_port, [this](const std::string& body) { on_gsi(body); }, err))
    tab("Sightline : écoute de CS2 impossible (" + err + ") — les débuts de rounds manqueront.");
  encoder_ = std::thread([this] { encoder_loop(); });
  uploader_ = std::thread([this] { uploader_loop(); });
  wake_uploader(false);  // sessions restées sur le disque : nouvel essai au démarrage
  const uint64 cur = ts_.getCurrentServerConnectionHandlerID();
  {
    std::lock_guard<std::mutex> l(rec_mx_);
    track(rec_->ts_connection(connected(cur), win::now_us()), cur);
  }
  log(std::string("Sightline Comms ") + SIGHTLINE_VERSION + " prêt (" + dir_.u8string() + ")");
  return 0;
}

bool App::shutdown() {
  quit_ = true;  // d'abord : annule les appels HTTP en cours (envoi, test de la clé), TeamSpeak n'attend pas le réseau
  {
    std::lock_guard<std::mutex> l(up_mx_);
    wake_ = true;
  }
  up_cv_.notify_all();
  const bool closed = close_settings();
  gsi_.stop();
  {
    std::lock_guard<std::mutex> l(rec_mx_);
    recording_ = 0;
    if (rec_) {
      rec_->ts_connection(false, win::now_us());  // map en cours : session terminée, envoyée au prochain démarrage
      report();
    }
  }
  if (encoder_.joinable()) encoder_.join();
  if (uploader_.joinable()) uploader_.join();
  if (!closed) log("dialogue des réglages encore ouvert à l'arrêt : Sightline Comms reste en mémoire", LogLevel_WARNING);
  return closed;
}

// --- TeamSpeak ---

bool App::connected(uint64 schid) {
  int status = 0;
  return schid != 0 && ts_.getConnectionStatus(schid, &status) == ERROR_ok && status == STATUS_CONNECTION_ESTABLISHED;
}

// L'état « connecté » du cœur suit l'onglet COURANT quand rien n'est enregistré ; pendant un enregistrement il ne
// bouge que pour l'onglet enregistré (voir on_connect_status).
Change App::sync_ts(uint64 cur, int64_t now) {
  if (recording_ != 0) return Change::None;
  const Change c = rec_->ts_connection(connected(cur), now);
  track(c, cur);
  return c;
}

void App::on_connect_status(uint64 schid, int status) {
  if (status != STATUS_CONNECTION_ESTABLISHED && status != STATUS_DISCONNECTED) return;
  forget_idents(schid);  // les clientID d'une connexion ne valent plus rien pour la suivante
  const int64_t now = win::now_us();
  const uint64 cur = ts_.getCurrentServerConnectionHandlerID();
  Change stop = Change::None, start = Change::None;
  uint64 was = 0;
  {
    std::lock_guard<std::mutex> l(rec_mx_);
    was = recording_;
    if (was != 0 && !(status == STATUS_DISCONNECTED && schid == was)) return;  // un autre onglet : sans effet
    if (was != 0) {
      stop = rec_->ts_connection(false, now);
      track(stop, schid);
    }
    start = sync_ts(cur, now);
    report();
  }
  react(stop, was, 0);
  react(start, 0, cur);
}

void App::on_client_move(uint64 schid, anyID client, uint64 new_channel) {
  if (new_channel != 0) return;  // seulement les départs du serveur : le clientID pourra servir à un autre
  on_client_gone(schid, client);
}

void App::on_client_gone(uint64 schid, anyID client) {
  std::lock_guard<std::mutex> l(ident_mx_);
  idents_.erase({schid, client});
}

void App::forget_idents(uint64 schid) {
  std::lock_guard<std::mutex> l(ident_mx_);
  for (auto it = idents_.begin(); it != idents_.end();) it = it->first.first == schid ? idents_.erase(it) : std::next(it);
}

void App::on_playback(uint64 schid, anyID client, const short* samples, int frames, int channels) {
  if (schid == 0 || schid != recording_.load(std::memory_order_relaxed)) return;
  queue_.push(schid, client, false, win::now_us(), samples, frames, channels);
}

void App::on_captured(uint64 schid, const short* samples, int frames, int channels, const int* edited) {
  // *edited & 2 : TeamSpeak va envoyer ce son (l'enregistreur parle) ; sinon le micro est juste capté
  if (schid == 0 || schid != recording_.load(std::memory_order_relaxed) || !edited || !(*edited & 2)) return;
  queue_.push(schid, 0, true, win::now_us(), samples, frames, channels);
}

void App::on_menu(int id) {
  if (id == kMenuToggle) {
    const uint64 cur = ts_.getCurrentServerConnectionHandlerID();
    Change c = Change::None;
    Change pre = Change::None;
    uint64 was = 0;
    {
      std::lock_guard<std::mutex> l(rec_mx_);
      const int64_t now = win::now_us();
      pre = sync_ts(cur, now);  // onglet courant non connecté : pas de départ
      was = recording_;
      if (pre == Change::Started) {  // la map en cours démarre déjà l'enregistrement : rien à basculer
        c = Change::None;
        was = 0;
      } else {
        c = rec_->manual(now);
        track(c, cur);
      }
      report();
    }
    if (pre == Change::Started) c = pre;
    if (c == Change::None) tab("Sightline : connectez-vous d'abord à un serveur TeamSpeak.");
    react(c, was, cur);
  } else if (id == kMenuResend) {
    if (const auto last = outbox::latest(dir_ / "sessions")) {
      outbox::reset(*last);
      tab("Sightline : nouvel envoi de la dernière session…");
      wake_uploader(true);
    } else {
      tab("Sightline : aucune session enregistrée.");
    }
  } else if (id == kMenuSettings) {
    open_settings_async();
  }
}

void App::track(Change c, uint64 schid) {
  if (c == Change::Started || c == Change::Restarted) recording_ = schid;
  else if (c == Change::Stopped) recording_ = 0;
}

void App::react(Change c, uint64 stopped_schid, uint64 started_schid) {
  if (c == Change::Stopped || c == Change::Restarted) {
    if (connected(stopped_schid)) announce(stopped_schid, kStopText);
    tab("Sightline : fin de l'enregistrement des comms.");
    wake_uploader(true);
  }
  if (c == Change::Started || c == Change::Restarted) {
    announce(started_schid, kStartText);
    tab("Sightline : enregistrement des comms démarré.");
  }
}

void App::announce(uint64 schid, const std::string& text) {
  anyID me = 0;
  uint64 channel = 0;
  if (ts_.getClientID(schid, &me) != ERROR_ok || ts_.getChannelOfClient(schid, me, &channel) != ERROR_ok) return;
  ts_.requestSendChannelTextMsg(schid, text.c_str(), channel, nullptr);
}

void App::tab(const std::string& text) {
  if (ts_.printMessageToCurrentTab) ts_.printMessageToCurrentTab(text.c_str());
  log(text);
}

void App::log(const std::string& text, LogLevel level) {
  if (ts_.logMessage) ts_.logMessage(text.c_str(), level, "Sightline", 0);
}

void App::report() {
  rec_->take_finished();  // l'envoi relit les sessions sur le disque
  const std::string e = rec_->take_error();
  if (!e.empty()) log(e, LogLevel_WARNING);
}

// --- voix ---

std::string App::client_string(uint64 schid, anyID client, size_t flag) {
  char* s = nullptr;
  if (ts_.getClientVariableAsString(schid, client, flag, &s) != ERROR_ok || !s) return {};
  std::string out(s);
  ts_.freeMemory(s);
  return out;
}

App::Ident App::identity(uint64 schid, anyID client, bool self) {
  if (self && ts_.getClientID(schid, &client) != ERROR_ok) return {};
  std::lock_guard<std::mutex> l(ident_mx_);
  const auto key = std::make_pair(schid, client);
  if (const auto it = idents_.find(key); it != idents_.end()) return it->second;
  Ident id{client_string(schid, client, CLIENT_UNIQUE_IDENTIFIER), client_string(schid, client, CLIENT_NICKNAME)};
  if (!id.uid.empty()) idents_[key] = id;
  return id;
}

void App::encoder_loop() {
  VoiceBlock b;
  int64_t last_tick = win::now_us();
  while (!quit_) {
    const int64_t now = win::now_us();
    if (now - last_tick >= kTickEveryUs) {
      last_tick = now;
      on_tick();
    }
    if (!queue_.pop(b)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      continue;
    }
    const Ident id = identity(b.schid, b.client, b.self);
    if (id.uid.empty()) continue;
    std::lock_guard<std::mutex> l(rec_mx_);
    rec_->voice(id.uid, id.nickname, b.self, b.wall_us, b.pcm, b.frames);
    report();
  }
}

// --- CS2 ---

void App::on_gsi(const std::string& body) {
  const int64_t now = win::now_us();
  GsiState s;
  if (!parse_gsi(body, s) || s.token != token_) return;  // jeton absent ou faux : pas notre fichier .cfg
  const uint64 cur = ts_.getCurrentServerConnectionHandlerID();
  Change c = Change::None;
  Change pre = Change::None;
  uint64 was = 0;
  {
    std::lock_guard<std::mutex> l(rec_mx_);
    pre = sync_ts(cur, now);  // pas de départ si l'onglet courant n'est pas connecté
    was = recording_;
    c = rec_->gsi(s, now);
    track(c, cur);
    report();
  }
  react(pre, 0, cur);
  react(c, was, cur);
}

void App::on_tick() {
  const int64_t now = win::now_us();
  const uint64 cur = ts_.getCurrentServerConnectionHandlerID();
  Change c = Change::None;
  uint64 was = 0;
  {
    std::lock_guard<std::mutex> l(rec_mx_);
    was = recording_;
    c = rec_->tick(now);  // CS2 fermé ou planté sans gameover : fin de la session liée à la map
    track(c, cur);
    report();
  }
  react(c, was, cur);
}

std::string App::install_gsi() {
  const Settings s = settings();
  std::vector<fs::path> dirs;
  if (!s.cs2_cfg_dir.empty()) dirs.push_back(fs::u8path(s.cs2_cfg_dir));
  else dirs = win::find_cs2_cfg_dirs();
  if (dirs.empty()) {
    tab(std::string("Sightline : dossier de CS2 introuvable, indiquez-le") + kSettingsHint);
    return "dossier de CS2 introuvable";
  }
  std::string err;
  const int r = install_gsi_cfg(dirs.front(), s.gsi_port, s.gsi_token, err);
  if (r < 0) {
    tab("Sightline : fichier GSI impossible à installer (" + err + ").");
    return err;
  }
  if (r > 0) tab("Sightline : fichier GSI installé pour CS2 — relancez CS2 s'il est ouvert.");
  return "";
}

// --- envoi ---

std::string App::load_key() { return win::load_secret(dir_ / "key.bin").value_or(""); }

Settings App::settings() {
  std::lock_guard<std::mutex> l(settings_mx_);
  return settings_;
}

void App::wake_uploader(bool verbose) {
  {
    std::lock_guard<std::mutex> l(up_mx_);
    wake_ = true;
    verbose_ = verbose_ || verbose;
  }
  up_cv_.notify_all();
}

void App::uploader_loop() {
  std::unique_lock<std::mutex> l(up_mx_);
  while (!quit_) {
    up_cv_.wait_for(l, std::chrono::minutes(10), [this] { return quit_.load() || wake_; });
    if (quit_) break;
    const bool verbose = verbose_;
    wake_ = verbose_ = false;
    l.unlock();
    upload_pending(verbose);
    l.lock();
  }
}

void App::upload_pending(bool verbose) {
  const fs::path root = dir_ / "sessions";
  outbox::cleanup(root, win::now_us());
  const Settings s = settings();
  const std::string key = load_key();
  for (const outbox::Entry& e : outbox::scan(root)) {
    if (quit_) return;
    if (e.state != outbox::State::Pending) continue;
    const win::UploadResult r = win::upload_session(e.dir, s.site, key, win::now_us(), &quit_);
    switch (r.outcome) {
      case win::Outcome::Sent:
        tab("Sightline : " + r.message + ".");
        break;
      case win::Outcome::Rejected:
        tab("Sightline : session refusée (" + r.message + ").");
        break;
      case win::Outcome::Settings:  // toutes les sessions échoueraient de même : on attend les réglages
        if (verbose) tab("Sightline : " + r.message + kSettingsHint);
        return;
      case win::Outcome::Retry:  // réseau ou serveur : nouvel essai dans 10 min
        if (verbose && !quit_) tab("Sightline : envoi impossible pour l'instant (" + r.message + "), nouvel essai plus tard.");
        return;
    }
  }
}

// --- réglages ---

std::string App::save_from_dialog(const Settings& s, const std::string& key) {
  if (!s.cs2_cfg_dir.empty()) {
    std::error_code ec;
    if (!fs::is_directory(fs::u8path(s.cs2_cfg_dir), ec)) return "Dossier introuvable : " + s.cs2_cfg_dir;
  }
  {
    std::lock_guard<std::mutex> l(settings_mx_);
    settings_.site = s.site;
    settings_.cs2_cfg_dir = s.cs2_cfg_dir;
    if (!save_settings(dir_ / "settings.json", settings_)) return "Réglages impossibles à enregistrer";
  }
  if (!key.empty() && !win::save_secret(dir_ / "key.bin", key)) return "Clé impossible à enregistrer";
  const std::string gsi = install_gsi();
  wake_uploader(true);
  return gsi.empty() ? "" : "Réglages enregistrés, mais " + gsi;
}

void App::configure() {
  bool expected = false;
  if (!dialog_open_.compare_exchange_strong(expected, true)) return;  // déjà ouvert
  run_dialog();
}

void App::run_dialog() {  // dialog_open_ est déjà à true
  DialogApi api;
  api.load = [this] { return settings(); };
  api.has_key = [this] { return !load_key().empty(); };
  api.save = [this](const Settings& s, const std::string& key) { return save_from_dialog(s, key); };
  api.test = [this](const std::string& site, const std::string& key) {
    const win::KeyResult k = win::check_key(site, key.empty() ? load_key() : key, &quit_);
    return std::string(k.check == win::KeyCheck::Ok ? "✔ " : "✖ ") + k.message;
  };
  api.detect_cfg_dirs = [] { return win::find_cs2_cfg_dirs(); };
  api.opened = [this](HWND h) { dialog_hwnd_ = h; };
  show_settings_dialog(module_, nullptr, api);
  dialog_hwnd_ = nullptr;
  dialog_open_ = false;
}

void App::open_settings_async() {
  bool expected = false;
  if (!dialog_open_.compare_exchange_strong(expected, true)) return;  // marqué avant le fil : l'arrêt le voit
  if (dialog_.joinable()) dialog_.join();
  dialog_ = std::thread([this] { run_dialog(); });  // le fil de l'interface de TeamSpeak n'attend pas
}

bool App::close_settings() {
  // Le dialogue peut être ouvert sans que sa fenêtre soit encore publiée : on renvoie IDCANCEL jusqu'à sa fermeture
  // (5 s au plus). Jamais d'attente infinie : un fil encore ouvert est détaché et l'App reste en mémoire.
  for (int i = 0; i < 500 && dialog_open_; ++i) {
    if (HWND h = dialog_hwnd_.load()) PostMessageW(h, WM_COMMAND, IDCANCEL, 0);
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  if (dialog_open_) {
    if (dialog_.joinable()) dialog_.detach();
    return false;
  }
  if (dialog_.joinable()) dialog_.join();
  return true;
}
}  // namespace sl
