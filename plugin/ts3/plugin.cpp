// Fonctions exportées pour TeamSpeak 3 (API 26) : identité, cycle de vie, rappels audio et réseau, menus.
// Déclarations : third_party/ts3sdk/src/plugin.h (extern "C", __declspec(dllexport)).
#include <windows.h>

#include <atomic>
#include <cstdlib>
#include <cstring>

#include "core/version.h"
#include "teamspeak/public_definitions.h"
#include "plugin_definitions.h"
#include "ts3_functions.h"
#include "plugin.h"
#include "ts3/app.h"

namespace {
TS3Functions g_ts{};
std::atomic<sl::App*> g_app{nullptr};
char* g_plugin_id = nullptr;

PluginMenuItem* menu_item(int id, const char* text) {
  auto* m = static_cast<PluginMenuItem*>(std::malloc(sizeof(PluginMenuItem)));
  m->type = PLUGIN_MENU_TYPE_GLOBAL;
  m->id = id;
  strncpy_s(m->text, PLUGIN_MENU_BUFSZ, text, _TRUNCATE);
  m->icon[0] = '\0';
  return m;
}

HMODULE this_module() {
  HMODULE m = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                     reinterpret_cast<LPCWSTR>(&menu_item), &m);
  return m;
}
}  // namespace

const char* ts3plugin_name() { return "Sightline Comms"; }
const char* ts3plugin_version() { return SIGHTLINE_VERSION; }
int ts3plugin_apiVersion() { return 26; }
const char* ts3plugin_author() { return "Sightline"; }
const char* ts3plugin_description() {
  return "Enregistre les comms de chaque map (une piste par joueur, calée sur les rounds de CS2) et les envoie à "
         "Sightline pour le replay.";
}
void ts3plugin_setFunctionPointers(const struct TS3Functions funcs) { g_ts = funcs; }

int ts3plugin_init() {
  auto* app = new sl::App(g_ts, this_module());
  if (app->init() != 0) {
    delete app;
    return 1;
  }
  g_app = app;
  return 0;
}

void ts3plugin_shutdown() {
  if (sl::App* app = g_app.exchange(nullptr)) {
    if (app->shutdown()) {
      delete app;
    } else {
      // Un dialogue encore ouvert touche l'App et le code de la DLL : on garde l'App et on épingle le module pour que
      // TeamSpeak ne puisse pas le décharger (FreeLibrary sans effet) ; seul ce chemin le fait.
      HMODULE pinned = nullptr;
      GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                         reinterpret_cast<LPCWSTR>(&menu_item), &pinned);
    }
  }
  std::free(g_plugin_id);
  g_plugin_id = nullptr;
}

int ts3plugin_offersConfigure() { return PLUGIN_OFFERS_CONFIGURE_NEW_THREAD; }
void ts3plugin_configure(void*, void*) {
  if (sl::App* app = g_app.load()) app->configure();
}
void ts3plugin_registerPluginID(const char* id) {
  std::free(g_plugin_id);
  g_plugin_id = _strdup(id);
}
void ts3plugin_freeMemory(void* data) { std::free(data); }
int ts3plugin_requestAutoload() { return 1; }

void ts3plugin_initMenus(struct PluginMenuItem*** items, char** icon) {
  *items = static_cast<PluginMenuItem**>(std::malloc(sizeof(PluginMenuItem*) * 4));
  (*items)[0] = menu_item(sl::kMenuToggle, "Enregistrer maintenant / Arrêter");
  (*items)[1] = menu_item(sl::kMenuResend, "Renvoyer la dernière session");
  (*items)[2] = menu_item(sl::kMenuSettings, "Réglages");
  (*items)[3] = nullptr;
  *icon = nullptr;
}

void ts3plugin_onMenuItemEvent(uint64, enum PluginMenuType type, int id, uint64) {
  sl::App* app = g_app.load();
  if (app && type == PLUGIN_MENU_TYPE_GLOBAL) app->on_menu(id);
}
void ts3plugin_onConnectStatusChangeEvent(uint64 schid, int status, unsigned int) {
  if (sl::App* app = g_app.load()) app->on_connect_status(schid, status);
}
void ts3plugin_onClientMoveEvent(uint64 schid, anyID client, uint64, uint64 new_channel, int, const char*) {
  if (sl::App* app = g_app.load()) app->on_client_move(schid, client, new_channel);
}
void ts3plugin_onClientMoveTimeoutEvent(uint64 schid, anyID client, uint64, uint64, int, const char*) {
  if (sl::App* app = g_app.load()) app->on_client_gone(schid, client);
}
void ts3plugin_onClientKickFromServerEvent(uint64 schid, anyID client, uint64, uint64, int, anyID, const char*,
                                           const char*, const char*) {
  if (sl::App* app = g_app.load()) app->on_client_gone(schid, client);
}
void ts3plugin_onClientBanFromServerEvent(uint64 schid, anyID client, uint64, uint64, int, anyID, const char*,
                                          const char*, uint64, const char*) {
  if (sl::App* app = g_app.load()) app->on_client_gone(schid, client);
}
void ts3plugin_onEditPlaybackVoiceDataEvent(uint64 schid, anyID client, short* samples, int count, int channels) {
  if (sl::App* app = g_app.load()) app->on_playback(schid, client, samples, count, channels);
}
void ts3plugin_onEditCapturedVoiceDataEvent(uint64 schid, short* samples, int count, int channels, int* edited) {
  if (sl::App* app = g_app.load()) app->on_captured(schid, samples, count, channels, edited);
}
