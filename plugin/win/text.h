// UTF-8 (tout le plugin) ↔ UTF-16 (API Windows).
#pragma once
#include <string>

namespace sl::win {
std::wstring widen(const std::string& utf8);
std::string narrow(const std::wstring& utf16);
}  // namespace sl::win
