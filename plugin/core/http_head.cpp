#include "core/http_head.h"

#include <cctype>
#include <cstdint>

namespace sl {
HttpHead parse_http_head(const std::string& head) {
  HttpHead h;
  const size_t eol = head.find("\r\n");
  const std::string line = head.substr(0, eol);
  const size_t a = line.find(' ');
  const size_t b = a == std::string::npos ? a : line.find(' ', a + 1);
  if (a == std::string::npos || b == std::string::npos) return h;
  h.method = line.substr(0, a);
  h.target = line.substr(a + 1, b - a - 1);
  if (line.compare(b + 1, 5, "HTTP/") != 0 || h.method.empty() || h.target.empty()) return h;
  size_t pos = eol == std::string::npos ? head.size() : eol + 2;
  while (pos < head.size()) {
    size_t end = head.find("\r\n", pos);
    if (end == std::string::npos) end = head.size();
    const std::string l = head.substr(pos, end - pos);
    pos = end + 2;
    const size_t colon = l.find(':');
    if (colon == std::string::npos) continue;
    std::string name = l.substr(0, colon);
    for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (name != "content-length") continue;
    size_t k = colon + 1;
    while (k < l.size() && l[k] == ' ') ++k;
    uint64_t n = 0;  // 64 bits : le calcul ne déborde jamais, même en 32 bits
    bool digits = false;
    for (; k < l.size() && std::isdigit(static_cast<unsigned char>(l[k])); ++k) {
      digits = true;
      n = n * 10 + static_cast<uint64_t>(l[k] - '0');
      if (n > (uint64_t(1) << 30)) return h;
    }
    if (!digits) return h;
    h.content_length = static_cast<size_t>(n);
  }
  h.ok = true;
  return h;
}
}  // namespace sl
