// Aperçu du dialogue des réglages sans TeamSpeak. Réglages et clé dans %TEMP%\sightline-preview.
// --auto-close (CTest) : le dialogue s'ouvre puis se ferme seul ; code 0 si la ressource s'est chargée.
#include <windows.h>

#include <filesystem>
#include <string>

#include "core/settings.h"
#include "ts3/settings_dialog.h"
#include "win/secret.h"
#include "win/steam_paths.h"
#include "win/upload.h"

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR cmd, int) {
  const bool auto_close = std::wstring(cmd ? cmd : L"").find(L"--auto-close") != std::wstring::npos;
  const auto dir = std::filesystem::temp_directory_path() / "sightline-preview";
  std::filesystem::create_directories(dir);
  sl::DialogApi api;
  api.load = [&] { return sl::load_settings(dir / "settings.json"); };
  api.has_key = [&] { return sl::win::load_secret(dir / "key.bin").has_value(); };
  api.save = [&](const sl::Settings& s, const std::string& key) -> std::string {
    if (!sl::save_settings(dir / "settings.json", s)) return "Réglages impossibles à enregistrer";
    if (!key.empty() && !sl::win::save_secret(dir / "key.bin", key)) return "Clé impossible à enregistrer";
    return "";
  };
  api.test = [&](const std::string& site, const std::string& key) {
    const std::string k = key.empty() ? sl::win::load_secret(dir / "key.bin").value_or("") : key;
    return sl::win::check_key(site, k).message;
  };
  api.detect_cfg_dirs = [] { return sl::win::find_cs2_cfg_dirs(); };
  api.opened = [&](HWND h) {
    if (h && auto_close) PostMessageW(h, WM_COMMAND, IDCANCEL, 0);
  };
  const INT_PTR r = sl::show_settings_dialog(inst, nullptr, api);
  return r == IDOK || r == IDCANCEL ? 0 : 1;
}
