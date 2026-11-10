// Réglages du plugin (…\plugins\sightline\settings.json). La clé d'API n'y est pas : chiffrée à part (key.bin).
#pragma once
#include <cstddef>
#include <filesystem>
#include <string>

namespace sl {
struct Settings {
  std::string site = "https://sightline.example.com";  // adresse de Sightline
  std::string cs2_cfg_dir;                             // dossier cfg de CS2 indiqué à la main ("" : trouvé via Steam)
  std::string gsi_token;                               // jeton des messages GSI (écrit dans le .cfg)
  int gsi_port = 47811;                                // écoute locale 127.0.0.1
};
Settings load_settings(const std::filesystem::path& file);  // défauts si absent ou illisible
bool save_settings(const std::filesystem::path& file, const Settings& s);
std::string random_hex(size_t bytes);  // std::random_device (rand_s sous MSVC : aléa du système)
// "https://x/" → "https://x" ; "" si l'adresse ne commence pas par http:// ou https://
std::string clean_site(const std::string& url);
}  // namespace sl
