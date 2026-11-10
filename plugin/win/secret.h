// Clé d'API chiffrée pour le compte Windows (DPAPI, CryptProtectData) : illisible sur un autre compte ou PC.
#pragma once
#include <filesystem>
#include <optional>
#include <string>

namespace sl::win {
bool save_secret(const std::filesystem::path& file, const std::string& secret);
std::optional<std::string> load_secret(const std::filesystem::path& file);
}  // namespace sl::win
