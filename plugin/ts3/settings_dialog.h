// Réglages du plugin : adresse de Sightline, clé d'API (chiffrée pour le compte Windows), dossier cfg de CS2.
#pragma once
#include <windows.h>

#include <filesystem>
#include <functional>
#include <string>
#include <vector>

#include "core/settings.h"

namespace sl {
struct DialogApi {
  std::function<Settings()> load;
  std::function<bool()> has_key;
  // Enregistre (clé vide : garder l'ancienne) ; "" si tout va bien, sinon le problème à afficher
  std::function<std::string(const Settings&, const std::string& key)> save;
  // Teste l'adresse et la clé (clé vide : celle enregistrée) ; texte du résultat
  std::function<std::string(const std::string& site, const std::string& key)> test;
  std::function<std::vector<std::filesystem::path>()> detect_cfg_dirs;
  // Fenêtre ouverte (nullptr à la fermeture) : la DLL la ferme si TeamSpeak décharge le plugin
  std::function<void(HWND)> opened;
};
// Modal ; `module` contient la ressource IDD_SETTINGS (la DLL, ou l'aperçu). IDOK, IDCANCEL ou −1.
INT_PTR show_settings_dialog(HINSTANCE module, HWND parent, const DialogApi& api);
}  // namespace sl
