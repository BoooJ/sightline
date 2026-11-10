#include "win/steam_paths.h"

#include <windows.h>

#include <fstream>
#include <iterator>
#include <optional>
#include <string>

#include "core/steam.h"

namespace fs = std::filesystem;

namespace sl::win {
namespace {
std::optional<fs::path> reg_path(HKEY root, const wchar_t* key, const wchar_t* name) {
  wchar_t buf[1024] = {};
  DWORD size = sizeof buf;
  if (RegGetValueW(root, key, name, RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS) return std::nullopt;
  return fs::path(buf);
}

void add_unique(std::vector<fs::path>& v, const fs::path& d) {
  std::error_code ec;
  if (!fs::is_directory(d, ec)) return;
  for (const fs::path& x : v)
    if (fs::equivalent(x, d, ec)) return;
  v.push_back(d);
}
}  // namespace

std::vector<fs::path> find_cs2_cfg_dirs() {
  std::vector<fs::path> roots;
  if (auto p = reg_path(HKEY_CURRENT_USER, L"Software\\Valve\\Steam", L"SteamPath")) roots.push_back(*p);
  if (auto p = reg_path(HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Valve\\Steam", L"InstallPath")) roots.push_back(*p);
  std::vector<fs::path> listed, others;
  for (const fs::path& root : roots) {
    std::ifstream f(root / "steamapps" / "libraryfolders.vdf", std::ios::binary);
    const std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    for (const SteamLibrary& lib : parse_libraryfolders(text))
      add_unique(lib.has_cs2 ? listed : others, cs2_cfg_dir(fs::u8path(lib.path)));
    add_unique(others, cs2_cfg_dir(root));
  }
  for (const fs::path& d : others) add_unique(listed, d);
  return listed;
}
}  // namespace sl::win
