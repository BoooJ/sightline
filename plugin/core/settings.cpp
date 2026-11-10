#include "core/settings.h"

#include <cctype>
#include <fstream>
#include <iterator>
#include <random>

#include "core/json.h"

namespace fs = std::filesystem;

namespace sl {
Settings load_settings(const fs::path& file) {
  Settings s;
  std::ifstream f(file, std::ios::binary);
  if (!f) return s;
  const std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  json::Value v;
  if (!json::parse(text, v) || !v.is_object()) return s;
  s.site = v.string_or("site", s.site);
  s.cs2_cfg_dir = v.string_or("cs2_cfg_dir", s.cs2_cfg_dir);
  s.gsi_token = v.string_or("gsi_token", s.gsi_token);
  const double port = v.number_or("gsi_port", s.gsi_port);
  if (port >= 1024 && port <= 65535) s.gsi_port = static_cast<int>(port);
  return s;
}

bool save_settings(const fs::path& file, const Settings& s) {
  std::error_code ec;
  fs::create_directories(file.parent_path(), ec);
  std::ofstream f(file, std::ios::binary | std::ios::trunc);
  f << "{\"site\":" << json::quote(s.site) << ",\"cs2_cfg_dir\":" << json::quote(s.cs2_cfg_dir)
    << ",\"gsi_token\":" << json::quote(s.gsi_token) << ",\"gsi_port\":" << s.gsi_port << "}\n";
  f.close();
  return !f.fail();
}

std::string random_hex(size_t bytes) {
  static const char* hex = "0123456789abcdef";
  std::random_device rd;
  std::string out;
  for (size_t i = 0; i < bytes; ++i) {
    const unsigned v = rd() & 0xFF;
    out += hex[v >> 4];
    out += hex[v & 15];
  }
  return out;
}

std::string clean_site(const std::string& url) {
  size_t a = 0, b = url.size();
  while (a < b && url[a] == ' ') ++a;
  while (b > a && url[b - 1] == ' ') --b;
  std::string u = url.substr(a, b - a);
  if (!u.empty() && u.back() == '/') u.pop_back();
  size_t host_at = 0;
  auto starts = [&](const char* p) {
    const size_t n = std::char_traits<char>::length(p);
    if (u.size() < n) return false;
    for (size_t i = 0; i < n; ++i)
      if (std::tolower(static_cast<unsigned char>(u[i])) != p[i]) return false;
    return true;
  };
  if (starts("https://")) host_at = 8;
  else if (starts("http://")) host_at = 7;
  else return "";
  const std::string rest = u.substr(host_at);
  const size_t colon = rest.find(':');
  const std::string host = rest.substr(0, colon);
  if (host.empty() || host.front() == '.' || host.front() == '-' || host.back() == '.' || host.back() == '-') return "";
  for (const char c : host)
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != '.' && c != '-') return "";
  if (colon != std::string::npos) {
    const std::string port = rest.substr(colon + 1);
    if (port.empty() || port.size() > 5) return "";
    for (const char c : port)
      if (c < '0' || c > '9') return "";
    const int n = std::stoi(port);
    if (n < 1 || n > 65535) return "";
  }
  return u;
}
}  // namespace sl
