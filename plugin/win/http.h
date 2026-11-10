// POST HTTP(S) par WinHTTP (proxy du système), corps envoyé par morceaux depuis le disque, annulable.
#pragma once
#include <atomic>
#include <string>
#include <vector>

#include "core/multipart.h"

namespace sl::win {
struct HttpResult {
  int status = 0;  // 0 : pas de réponse (réseau, annulation)
  std::string body;
  std::string error;
};
HttpResult post(const std::string& url, const std::string& authorization, const std::string& content_type,
                const std::vector<Segment>& body, int timeout_s, const std::atomic<bool>* cancel = nullptr);
inline HttpResult post_multipart(const std::string& url, const std::string& authorization, const Multipart& mp,
                                 int timeout_s, const std::atomic<bool>* cancel = nullptr) {
  return post(url, authorization, mp.content_type(), mp.segments, timeout_s, cancel);
}
}  // namespace sl::win
