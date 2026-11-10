// Requête HTTP reçue par l'écoute GSI locale : ligne de requête et Content-Length seulement.
#pragma once
#include <cstddef>
#include <string>

namespace sl {
struct HttpHead {
  bool ok = false;
  std::string method, target;
  size_t content_length = 0;
};
// `head` : tout ce qui précède la ligne vide (le \r\n\r\n final exclu)
HttpHead parse_http_head(const std::string& head);
}  // namespace sl
