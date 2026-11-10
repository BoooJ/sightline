#include "win/gsi_server.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include "core/http_head.h"

namespace sl::win {
bool GsiServer::start(int port, Handler on_body, std::string& error) {
  stop();
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    error = "Winsock indisponible";
    return false;
  }
  winsock_ = true;
  const SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) {
    error = "socket impossible";
    stop();
    return false;
  }
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(static_cast<u_short>(port));
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || listen(s, 8) != 0) {
    error = "port " + std::to_string(port) + " déjà pris";
    closesocket(s);
    stop();
    return false;
  }
  sock_ = static_cast<uintptr_t>(s);
  on_body_ = std::move(on_body);
  stop_ = false;
  thread_ = std::thread([this] { loop(); });
  return true;
}

void GsiServer::stop() {
  stop_ = true;
  if (thread_.joinable()) thread_.join();
  if (sock_ != ~uintptr_t(0)) {
    closesocket(static_cast<SOCKET>(sock_));
    sock_ = ~uintptr_t(0);
  }
  if (winsock_) {
    WSACleanup();
    winsock_ = false;
  }
}

void GsiServer::loop() {
  const SOCKET s = static_cast<SOCKET>(sock_);
  while (!stop_) {
    fd_set set;
    FD_ZERO(&set);
    FD_SET(s, &set);
    timeval tv{0, 200000};  // 200 ms : stop() n'attend jamais longtemps
    if (select(0, &set, nullptr, nullptr, &tv) <= 0) continue;
    const SOCKET c = accept(s, nullptr, nullptr);
    if (c == INVALID_SOCKET) continue;
    serve(static_cast<uintptr_t>(c));
    closesocket(c);
  }
}

void GsiServer::serve(uintptr_t cs) {
  const SOCKET c = static_cast<SOCKET>(cs);
  const DWORD timeout = 2000;
  setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof timeout);
  std::string data;
  char buf[4096];
  size_t end;
  while ((end = data.find("\r\n\r\n")) == std::string::npos) {
    const int got = recv(c, buf, sizeof buf, 0);
    if (got <= 0 || data.size() > 16384) return;
    data.append(buf, static_cast<size_t>(got));
  }
  const HttpHead h = parse_http_head(data.substr(0, end));
  std::string body = data.substr(end + 4);
  const char* status = "200 OK";
  if (!h.ok) {
    status = "400 Bad Request";
  } else if (h.method != "POST") {
    status = "405 Method Not Allowed";
  } else if (h.content_length > kMaxBody) {
    status = "413 Payload Too Large";
  } else {
    while (body.size() < h.content_length) {
      const int got = recv(c, buf, sizeof buf, 0);
      if (got <= 0) return;
      body.append(buf, static_cast<size_t>(got));
    }
    body.resize(h.content_length);
  }
  const std::string reply = std::string("HTTP/1.1 ") + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
  send(c, reply.data(), static_cast<int>(reply.size()), 0);
  if (status[0] == '2' && on_body_) on_body_(body);
}
}  // namespace sl::win
