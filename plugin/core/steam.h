// Trouver CS2 (libraryfolders.vdf de Steam) et le fichier Game State Integration à y installer.
#pragma once
#include <filesystem>
#include <string>
#include <vector>

namespace sl {
struct SteamLibrary {
  std::string path;      // UTF-8, échappements VDF retirés
  bool has_cs2 = false;  // l'application 730 est listée (liste parfois périmée : tester aussi le dossier)
};
std::vector<SteamLibrary> parse_libraryfolders(const std::string& vdf);
// <bibliothèque>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg
std::filesystem::path cs2_cfg_dir(const std::filesystem::path& library);
constexpr const char* kGsiFileName = "gamestate_integration_sightline.cfg";
std::string gsi_cfg(int port, const std::string& token);
// Écrit le fichier s'il manque ou diffère : 1 écrit, 0 déjà à jour, −1 impossible (`error` rempli)
int install_gsi_cfg(const std::filesystem::path& cfg_dir, int port, const std::string& token, std::string& error);
}  // namespace sl
