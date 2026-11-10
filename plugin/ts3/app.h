// La DLL : relie TeamSpeak (fonctions et rappels du SDK), CS2 (écoute GSI) et Sightline (envoi) au cœur.
#pragma once
#include <windows.h>

#include <atomic>
#include <condition_variable>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#include "core/block_queue.h"
#include "core/recorder.h"
#include "core/settings.h"
#include "teamspeak/public_definitions.h"
#include "ts3_functions.h"
#include "win/gsi_server.h"

namespace sl {
enum MenuId { kMenuToggle = 1, kMenuResend = 2, kMenuSettings = 3 };

class App {
 public:
  App(const TS3Functions& ts, HMODULE module) : ts_(ts), module_(module) {}
  int init();       // 0 : prêt ; 1 : échec (TeamSpeak n'active pas le plugin)
  // Session en cours terminée et gardée sur le disque ; fils arrêtés. false : un dialogue de réglages résiste à la
  // fermeture, l'App ne doit pas être libérée (elle serait encore touchée par ce fil).
  bool shutdown();
  void on_connect_status(uint64 schid, int status);
  void on_client_move(uint64 schid, anyID client, uint64 new_channel);
  void on_client_gone(uint64 schid, anyID client);  // timeout, expulsion ou bannissement

  void on_playback(uint64 schid, anyID client, const short* samples, int frames, int channels);    // fil audio
  void on_captured(uint64 schid, const short* samples, int frames, int channels, const int* edited);  // fil audio
  void on_menu(int id);
  void configure();  // dialogue des réglages, dans le fil appelant

 private:
  struct Ident {
    std::string uid, nickname;
  };
  void on_gsi(const std::string& body);
  void on_tick();  // fil d'encodage, environ une fois par seconde : fin de session si CS2 est muet
  void track(Change c, uint64 schid);  // sous rec_mx_ : onglet enregistré
  void react(Change c, uint64 stopped_schid, uint64 started_schid);
  void encoder_loop();
  void uploader_loop();
  void upload_pending(bool verbose);
  void wake_uploader(bool verbose);
  std::string install_gsi();
  Ident identity(uint64 schid, anyID client, bool self);
  std::string client_string(uint64 schid, anyID client, size_t flag);
  bool connected(uint64 schid);
  void announce(uint64 schid, const std::string& text);
  void tab(const std::string& text);
  void log(const std::string& text, LogLevel level = LogLevel_INFO);
  void report();  // sous rec_mx_ : erreurs du cœur vers le journal
  std::string load_key();
  Settings settings();
  std::string save_from_dialog(const Settings& s, const std::string& key);
  void open_settings_async();
  void run_dialog();
  bool close_settings();  // true : plus aucun dialogue ouvert
  void forget_idents(uint64 schid);  // tous les clients de cet onglet
  Change sync_ts(uint64 cur, int64_t now);  // sous rec_mx_ : état « connecté » du cœur = onglet courant

  TS3Functions ts_;
  HMODULE module_;
  std::filesystem::path dir_;
  std::mutex settings_mx_;
  Settings settings_;
  std::string token_;  // jeton GSI, fixé à init
  BlockQueue queue_{1024};
  std::mutex rec_mx_;
  std::unique_ptr<Recorder> rec_;
  std::atomic<uint64> recording_{0};  // onglet enregistré (0 : aucun)
  std::mutex ident_mx_;
  std::map<std::pair<uint64, anyID>, Ident> idents_;
  win::GsiServer gsi_;
  std::atomic<bool> quit_{false};  // aussi le drapeau d'annulation des appels HTTP
  std::thread encoder_, uploader_, dialog_;
  std::mutex up_mx_;
  std::condition_variable up_cv_;
  bool wake_ = false, verbose_ = false;
  std::atomic<bool> dialog_open_{false};
  std::atomic<HWND> dialog_hwnd_{nullptr};
};
}  // namespace sl
