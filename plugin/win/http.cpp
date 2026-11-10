#include "win/http.h"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <chrono>
#include <fstream>
#include <mutex>
#include <thread>

#include "core/version.h"
#include "win/text.h"

namespace sl::win {
namespace {
struct Handle {
  HINTERNET h = nullptr;
  explicit Handle(HINTERNET v) : h(v) {}
  ~Handle() {
    if (h) WinHttpCloseHandle(h);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

// Poignée de requête qu'un fil de surveillance peut fermer pour interrompre un appel WinHTTP bloqué ;
// jamais fermée deux fois.
struct AbortableHandle {
  HINTERNET h = nullptr;
  std::mutex mx;
  bool closed = false;
  void close() {
    std::lock_guard<std::mutex> l(mx);
    if (h && !closed) WinHttpCloseHandle(h);
    closed = true;
  }
  ~AbortableHandle() { close(); }
};

// Surveille `cancel` pendant la requête (sans fil si cancel est nul) ; le destructeur arrête et joint le fil.
struct Watcher {
  AbortableHandle& req;
  std::atomic<bool> done{false};
  std::thread th;
  Watcher(AbortableHandle& r, const std::atomic<bool>* cancel) : req(r) {
    if (!cancel) return;
    th = std::thread([this, cancel] {
      while (!done.load()) {
        if (cancel->load()) {
          req.close();
          return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    });
  }
  ~Watcher() {
    done = true;
    if (th.joinable()) th.join();
  }
};

std::string failure(const char* what) {
  return std::string(what) + " (erreur " + std::to_string(GetLastError()) + ")";
}

bool write_all(HINTERNET req, const char* p, size_t n, const std::atomic<bool>* cancel) {
  while (n > 0) {
    if (cancel && cancel->load()) {
      SetLastError(ERROR_CANCELLED);
      return false;
    }
    DWORD wrote = 0;
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(n, size_t(1) << 20));
    if (!WinHttpWriteData(req, p, chunk, &wrote) || wrote == 0) return false;
    p += wrote;
    n -= wrote;
  }
  return true;
}

HttpResult post_inner(const std::string& url, const std::string& authorization, const std::string& content_type,
                      const std::vector<Segment>& body, int timeout_s, const std::atomic<bool>* cancel) {
  HttpResult r;
  if (cancel && cancel->load()) return r;
  const std::wstring wurl = widen(url);
  URL_COMPONENTS uc{};
  uc.dwStructSize = sizeof uc;
  wchar_t host[256] = {};
  wchar_t path[2048] = {};
  uc.lpszHostName = host;
  uc.dwHostNameLength = 256;
  uc.lpszUrlPath = path;
  uc.dwUrlPathLength = 2048;
  if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) {
    r.error = "adresse invalide : " + url;
    return r;
  }
  Handle session(WinHttpOpen(widen(std::string("Sightline-Comms/") + SIGHTLINE_VERSION).c_str(),
                             WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
  if (!session.h) {
    r.error = failure("WinHTTP indisponible");
    return r;
  }
  const int ms = timeout_s * 1000;
  WinHttpSetTimeouts(session.h, 10000, 10000, ms, ms);
  Handle conn(WinHttpConnect(session.h, host, uc.nPort, 0));
  if (!conn.h) {
    r.error = failure("connexion impossible");
    return r;
  }
  const DWORD flags = uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
  AbortableHandle req;
  req.h = WinHttpOpenRequest(conn.h, L"POST", path, nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
  if (!req.h) {
    r.error = failure("requête impossible");
    return r;
  }
  const uint64_t total = segments_size(body);
  if (total > 0xFFFFFFFFull) {
    r.error = "envoi trop lourd";
    return r;
  }
  Watcher watcher(req, cancel);  // déclaré après req : joint avant la fermeture de req
  if (cancel && cancel->load()) return r;
  const std::wstring headers = widen("Authorization: " + authorization + "\r\nContent-Type: " + content_type + "\r\n");
  if (!WinHttpSendRequest(req.h, headers.c_str(), static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0,
                          static_cast<DWORD>(total), 0)) {
    r.error = failure("Sightline injoignable");
    return r;
  }
  std::vector<char> buf(size_t(1) << 20);
  for (const Segment& s : body) {
    if (s.file.empty()) {
      if (!write_all(req.h, s.bytes.data(), s.bytes.size(), cancel)) {
        r.error = failure("envoi interrompu");
        return r;
      }
      continue;
    }
    std::ifstream f(s.file, std::ios::binary);
    if (!f) {
      r.error = "piste illisible : " + s.file.u8string();
      return r;
    }
    while (f) {
      f.read(buf.data(), static_cast<std::streamsize>(buf.size()));
      const std::streamsize got = f.gcount();
      if (got > 0 && !write_all(req.h, buf.data(), static_cast<size_t>(got), cancel)) {
        r.error = failure("envoi interrompu");
        return r;
      }
    }
  }
  if (!WinHttpReceiveResponse(req.h, nullptr)) {
    r.error = failure("pas de réponse de Sightline");
    return r;
  }
  DWORD status = 0, len = sizeof status;
  WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                      &status, &len, WINHTTP_NO_HEADER_INDEX);
  r.status = static_cast<int>(status);
  for (;;) {
    DWORD avail = 0;
    if (!WinHttpQueryDataAvailable(req.h, &avail) || avail == 0) break;
    std::string chunk(avail, '\0');
    DWORD got = 0;
    if (!WinHttpReadData(req.h, chunk.data(), avail, &got) || got == 0) break;
    r.body.append(chunk.data(), got);
    if (r.body.size() > 65536) break;
  }
  return r;
}

}  // namespace

HttpResult post(const std::string& url, const std::string& authorization, const std::string& content_type,
                const std::vector<Segment>& body, int timeout_s, const std::atomic<bool>* cancel) {
  HttpResult r = post_inner(url, authorization, content_type, body, timeout_s, cancel);
  if (r.status == 0 && cancel && cancel->load()) r.error = "annulé";
  return r;
}
}  // namespace sl::win
