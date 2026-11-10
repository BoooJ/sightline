#include "win/secret.h"

#include <windows.h>
#include <dpapi.h>

#include <fstream>
#include <iterator>

namespace sl::win {
bool save_secret(const std::filesystem::path& file, const std::string& secret) {
  DATA_BLOB in{static_cast<DWORD>(secret.size()), reinterpret_cast<BYTE*>(const_cast<char*>(secret.data()))};
  DATA_BLOB out{};
  if (!CryptProtectData(&in, L"Sightline Comms", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out))
    return false;
  std::ofstream f(file, std::ios::binary | std::ios::trunc);
  f.write(reinterpret_cast<const char*>(out.pbData), static_cast<std::streamsize>(out.cbData));
  LocalFree(out.pbData);
  f.close();
  return !f.fail();
}

std::optional<std::string> load_secret(const std::filesystem::path& file) {
  std::ifstream f(file, std::ios::binary);
  if (!f) return std::nullopt;
  std::string blob((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  DATA_BLOB in{static_cast<DWORD>(blob.size()), reinterpret_cast<BYTE*>(blob.data())};
  DATA_BLOB out{};
  if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out))
    return std::nullopt;
  std::string s(reinterpret_cast<const char*>(out.pbData), out.cbData);
  SecureZeroMemory(out.pbData, out.cbData);
  LocalFree(out.pbData);
  return s;
}
}  // namespace sl::win
