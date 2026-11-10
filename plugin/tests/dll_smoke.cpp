// Charge la DLL du plugin comme TeamSpeak 3 (fausse table TS3Functions), simule une map (GSI + voix) et vérifie
// la session écrite. Rien n'est envoyé (pas de clé) et rien n'est écrit chez CS2 (dossier cfg temporaire).
// Usage : sightline_dll_smoke <chemin de la DLL>
#include <winsock2.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "core/json.h"
#include "gsi_json.h"
#include "net_client.h"
#include "plugin_definitions.h"
#include "teamspeak/public_definitions.h"
#include "teamspeak/public_errors.h"
#include "ts3_functions.h"

namespace fs = std::filesystem;

namespace {
const char* kStart = "🔴 Comms enregistrées pour Sightline (map en cours)";
const char* kStop = "⏹ Fin de l'enregistrement";
std::string g_config;  // dossier de configuration TeamSpeak simulé (UTF-8, terminé par \)
std::mutex g_mx;
std::vector<std::string> g_chat;
int g_failures = 0;
std::atomic<uint64> g_current{1};      // onglet courant
std::atomic<bool> g_up1{true}, g_up2{false};  // onglets 1 et 2 connectés ?
std::atomic<bool> g_kicked{false};     // le client 9 a changé d'identité (autre UID)

void expect(bool ok, const char* what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) ++g_failures;
}
char* dup(const char* s) {
  char* p = static_cast<char*>(std::malloc(std::strlen(s) + 1));
  std::strcpy(p, s);
  return p;
}
std::string read_text(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

// --- fausse table de fonctions de TeamSpeak : onglet 1 connecté, nous = client 7 (salon 42), un coéquipier = 9
void getConfigPath(char* path, size_t max) { strncpy_s(path, max, g_config.c_str(), _TRUNCATE); }
unsigned int logMessage(const char* m, LogLevel, const char*, uint64) {
  std::printf("  journal : %s\n", m);
  return ERROR_ok;
}
void printMessageToCurrentTab(const char* m) { std::printf("  onglet : %s\n", m); }
uint64 getCurrentServerConnectionHandlerID() { return g_current; }
unsigned int getConnectionStatus(uint64 schid, int* r) {
  const bool up = schid == 1 ? g_up1.load() : schid == 2 ? g_up2.load() : false;
  *r = up ? STATUS_CONNECTION_ESTABLISHED : STATUS_DISCONNECTED;
  return ERROR_ok;
}
unsigned int getClientID(uint64, anyID* r) {
  *r = 7;
  return ERROR_ok;
}
unsigned int getChannelOfClient(uint64, anyID, uint64* r) {
  *r = 42;
  return ERROR_ok;
}
unsigned int getClientVariableAsString(uint64, anyID client, size_t flag, char** r) {
  if (flag == CLIENT_UNIQUE_IDENTIFIER) *r = dup(client == 7 ? "self-uid=" : g_kicked ? "uid-c=" : "uid-b=");
  else if (flag == CLIENT_NICKNAME) *r = dup(client == 7 ? "Moi" : "Invité");
  else return ERROR_parameter_invalid;
  return ERROR_ok;
}
unsigned int freeMemory(void* p) {
  std::free(p);
  return ERROR_ok;
}
unsigned int requestSendChannelTextMsg(uint64, const char* m, uint64 channel, const char*) {
  std::lock_guard<std::mutex> l(g_mx);
  g_chat.push_back(m);
  std::printf("  salon %llu : %s\n", static_cast<unsigned long long>(channel), m);
  return ERROR_ok;
}
bool wait_chat(const std::string& text, int ms, int times = 1) {
  for (int i = 0; i < ms / 20; ++i) {
    {
      std::lock_guard<std::mutex> l(g_mx);
      if (std::count(g_chat.begin(), g_chat.end(), text) >= times) return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  return false;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage : sightline_dll_smoke <dll>\n");
    return 2;
  }
  testnet::Winsock ws;
  const fs::path tmp = fs::temp_directory_path() / "sightline-dll-smoke";
  std::error_code ec;
  fs::remove_all(tmp, ec);
  const fs::path plugdir = tmp / "TS3Client" / "plugins" / "sightline";
  fs::create_directories(plugdir);
  fs::create_directories(tmp / "cs2cfg");
  std::ofstream(plugdir / "settings.json", std::ios::binary)
      << "{\"site\":\"http://127.0.0.1:9\",\"cs2_cfg_dir\":" << sl::json::quote((tmp / "cs2cfg").u8string())
      << ",\"gsi_token\":\"jeton-test\",\"gsi_port\":47812}";
  g_config = (tmp / "TS3Client").u8string() + "\\";

  HMODULE dll = LoadLibraryA(argv[1]);
  expect(dll != nullptr, "LoadLibrary");
  if (!dll) return 1;
  bool all = true;
  for (const char* n : {"ts3plugin_name", "ts3plugin_version", "ts3plugin_apiVersion", "ts3plugin_author",
                        "ts3plugin_description", "ts3plugin_setFunctionPointers", "ts3plugin_init",
                        "ts3plugin_shutdown", "ts3plugin_offersConfigure", "ts3plugin_configure",
                        "ts3plugin_registerPluginID", "ts3plugin_freeMemory", "ts3plugin_requestAutoload",
                        "ts3plugin_initMenus", "ts3plugin_onMenuItemEvent", "ts3plugin_onConnectStatusChangeEvent",
                        "ts3plugin_onClientMoveEvent", "ts3plugin_onClientMoveTimeoutEvent",
                        "ts3plugin_onClientKickFromServerEvent", "ts3plugin_onClientBanFromServerEvent",
                        "ts3plugin_onEditPlaybackVoiceDataEvent",
                        "ts3plugin_onEditCapturedVoiceDataEvent"}) {
    const bool found = GetProcAddress(dll, n) != nullptr;
    expect(found, n);
    all = all && found;
  }
  if (!all) return 1;
  auto name = reinterpret_cast<const char* (*)()>(GetProcAddress(dll, "ts3plugin_name"));
  auto api = reinterpret_cast<int (*)()>(GetProcAddress(dll, "ts3plugin_apiVersion"));
  auto autoload = reinterpret_cast<int (*)()>(GetProcAddress(dll, "ts3plugin_requestAutoload"));
  auto set_funcs = reinterpret_cast<void (*)(const TS3Functions)>(GetProcAddress(dll, "ts3plugin_setFunctionPointers"));
  auto reg_id = reinterpret_cast<void (*)(const char*)>(GetProcAddress(dll, "ts3plugin_registerPluginID"));
  auto init = reinterpret_cast<int (*)()>(GetProcAddress(dll, "ts3plugin_init"));
  auto shutdown = reinterpret_cast<void (*)()>(GetProcAddress(dll, "ts3plugin_shutdown"));
  auto init_menus = reinterpret_cast<void (*)(PluginMenuItem***, char**)>(GetProcAddress(dll, "ts3plugin_initMenus"));
  auto free_mem = reinterpret_cast<void (*)(void*)>(GetProcAddress(dll, "ts3plugin_freeMemory"));
  auto connect_status =
      reinterpret_cast<void (*)(uint64, int, unsigned int)>(GetProcAddress(dll, "ts3plugin_onConnectStatusChangeEvent"));
  auto playback =
      reinterpret_cast<void (*)(uint64, anyID, short*, int, int)>(GetProcAddress(dll, "ts3plugin_onEditPlaybackVoiceDataEvent"));
  auto captured =
      reinterpret_cast<void (*)(uint64, short*, int, int, int*)>(GetProcAddress(dll, "ts3plugin_onEditCapturedVoiceDataEvent"));
  expect(api() == 26, "API 26");
  expect(std::string(name()) == "Sightline Comms", "nom");
  expect(autoload() == 1, "activé d'office");

  TS3Functions f{};
  f.getConfigPath = getConfigPath;
  f.logMessage = logMessage;
  f.printMessageToCurrentTab = printMessageToCurrentTab;
  f.getCurrentServerConnectionHandlerID = getCurrentServerConnectionHandlerID;
  f.getConnectionStatus = getConnectionStatus;
  f.getClientID = getClientID;
  f.getChannelOfClient = getChannelOfClient;
  f.getClientVariableAsString = getClientVariableAsString;
  f.freeMemory = freeMemory;
  f.requestSendChannelTextMsg = requestSendChannelTextMsg;
  set_funcs(f);
  reg_id("sightline_smoke");
  expect(init() == 0, "init");

  PluginMenuItem** items = nullptr;
  char* icon = nullptr;
  init_menus(&items, &icon);
  std::vector<std::string> texts;
  for (int i = 0; items && items[i]; ++i) {
    texts.push_back(items[i]->text);
    free_mem(items[i]);
  }
  free_mem(items);
  expect(texts == std::vector<std::string>{"Enregistrer maintenant / Arrêter", "Renvoyer la dernière session", "Réglages"},
         "menus");

  auto kick = reinterpret_cast<void (*)(uint64, anyID, uint64, uint64, int, anyID, const char*, const char*, const char*)>(
      GetProcAddress(dll, "ts3plugin_onClientKickFromServerEvent"));
  auto feed = [&](int seconds_x50, bool mic_sends, int tone_from) {  // le coéquipier 9 parle ; le micro émet ou non
    std::vector<short> pcm(960);
    for (int k = 0; k < seconds_x50; ++k) {
      for (int i = 0; i < 960; ++i)
        pcm[i] = static_cast<short>(8000 * std::sin(2 * 3.14159265358979 * 440 * ((tone_from + k) * 960 + i) / 48000.0));
      playback(1, 9, pcm.data(), 960, 1);
      int sending = mic_sends ? 2 : 0;  // 2 : le micro part vers le serveur ; 0 : capté sans émettre, ignoré
      captured(1, pcm.data(), 960, 1, &sending);
      int idle = 0;
      captured(1, pcm.data(), 960, 1, &idle);
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(300));  // le fil d'encodage vide la file
  };

  connect_status(1, STATUS_CONNECTION_ESTABLISHED, 0);
  expect(testnet::post_gsi(47812, testgsi::map("mauvais-jeton", "warmup", "warmup", 0, 0, 0)).rfind("HTTP/1.1 200", 0) == 0,
         "écoute GSI");
  expect(!wait_chat(kStart, 300), "jeton faux : ignoré");
  g_current = 2;  // l'onglet courant n'est pas connecté : CS2 ne déclenche rien
  testnet::post_gsi(47812, testgsi::map("jeton-test", "warmup", "warmup", 0, 0, 0));
  expect(!wait_chat(kStart, 400), "onglet courant non connecté : pas de départ");
  g_current = 1;
  testnet::post_gsi(47812, testgsi::map("jeton-test", "warmup", "warmup", 0, 0, 0));
  expect(wait_chat(kStart, 3000), "annonce de début dans le salon");
  testnet::post_gsi(47812, testgsi::map("jeton-test", "live", "freezetime", 0, 0, 0));
  testnet::post_gsi(47812, testgsi::map("jeton-test", "live", "live", 0, 0, 0));
  feed(50, true, 0);  // 1 s : le coéquipier parle et nous aussi

  // Autre onglet (courant, lui-même déconnecté) : l'enregistrement de l'onglet 1 continue, sans ⏹
  g_current = 2;
  connect_status(2, STATUS_DISCONNECTED, 0);
  expect(!wait_chat(kStop, 500), "autre onglet déconnecté : pas de fin");
  g_current = 1;
  feed(10, true, 50);
  // Le clientID 9 est réutilisé par un autre joueur après une expulsion : nouvelle piste, nouvel UID
  g_kicked = true;
  kick(1, 9, 42, 0, 0, 0, "", "", "");
  feed(25, true, 60);
  testnet::post_gsi(47812, testgsi::map("jeton-test", "gameover", "over", 1, 1, 0));
  expect(wait_chat(kStop, 3000), "annonce de fin dans le salon");

  // 2e map : le micro est capté sans jamais émettre ; l'onglet 1 se déconnecte → fin de l'enregistrement
  std::this_thread::sleep_for(std::chrono::milliseconds(1100));  // dossiers de session nommés à la seconde
  testnet::post_gsi(47812, testgsi::map("jeton-test", "warmup", "warmup", 0, 0, 0));
  expect(wait_chat(kStart, 3000, 2), "2e annonce de début");
  feed(25, false, 0);
  g_up1 = false;
  connect_status(1, STATUS_DISCONNECTED, 0);
  const fs::path plugsessions = plugdir / "sessions";
  auto finished = [&] {
    int n = 0;
    std::error_code e2;
    for (const auto& d : fs::directory_iterator(plugsessions, e2))
      if (fs::exists(d.path() / "session.json")) ++n;
    return n;
  };
  for (int i = 0; i < 150 && finished() < 2; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(20));
  expect(finished() == 2, "déconnexion de l'onglet enregistré : la 2e session s'arrête");
  shutdown();
  FreeLibrary(dll);

  std::vector<fs::path> sessions;
  for (const auto& d : fs::directory_iterator(plugsessions)) sessions.push_back(d.path());
  std::sort(sessions.begin(), sessions.end());
  expect(sessions.size() == 2, "deux sessions sur le disque");
  if (sessions.size() == 2) {
    sl::json::Value v;
    expect(sl::json::parse(read_text(sessions[0] / "session.json"), v), "session.json lisible");
    expect(v.string_or("map") == "de_nuke", "carte");
    expect(v.get("rounds") && v.get("rounds")->arr.size() == 1, "un round");
    expect(v.get("score") && v.get("score")->is_array(), "score au gameover");
    const sl::json::Value* tracks = v.get("tracks");
    expect(tracks && tracks->arr.size() == 3, "trois pistes (voix entendue, autre UID après expulsion, micro)");
    bool heard = false, heard_c = false, self = false;
    for (const sl::json::Value& t : tracks ? tracks->arr : std::vector<sl::json::Value>{}) {
      heard = heard || (t.string_or("ts_uid") == "uid-b=" && t.string_or("ts_nickname") == "Invité");
      heard_c = heard_c || t.string_or("ts_uid") == "uid-c=";
      self = self || (t.string_or("ts_uid") == "self-uid=" && t.get("self") && t.get("self")->b);
    }
    expect(heard, "voix du coéquipier (UID et pseudo)");
    expect(heard_c, "clientID réutilisé après expulsion : piste du nouvel UID");
    expect(self, "micro de l'enregistreur (self)");
    expect(fs::file_size(sessions[0] / "t1.ogg") > 1000 && fs::file_size(sessions[0] / "t2.ogg") > 1000, "pistes Opus");
    expect(!fs::exists(sessions[0] / "sent.json"), "pas de clé : session gardée pour plus tard");

    sl::json::Value w;
    expect(sl::json::parse(read_text(sessions[1] / "session.json"), w), "2e session.json lisible");
    const sl::json::Value* t2 = w.get("tracks");
    bool any_self = false;
    for (const sl::json::Value& t : t2 ? t2->arr : std::vector<sl::json::Value>{})
      any_self = any_self || (t.get("self") && t.get("self")->b);
    expect(t2 && t2->arr.size() == 1 && !any_self, "micro jamais émis : aucune piste self");
  }
  const std::string cfg = read_text(tmp / "cs2cfg" / "gamestate_integration_sightline.cfg");
  expect(cfg.find("http://127.0.0.1:47812/gsi") != std::string::npos && cfg.find("jeton-test") != std::string::npos,
         "fichier GSI installé");
  std::printf("%d echec(s)\n", g_failures);
  return g_failures ? 1 : 0;
}
