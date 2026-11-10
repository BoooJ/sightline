// Petit client HTTP de test (Winsock) : requête brute vers 127.0.0.1, réponse lue jusqu'à la fermeture.
#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>

#include <string>

namespace testnet {
struct Winsock {
  Winsock() {
    WSADATA w;
    WSAStartup(MAKEWORD(2, 2), &w);
  }
  ~Winsock() { WSACleanup(); }
};

inline std::string send_raw(int port, const std::string& request) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return {};
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(static_cast<u_short>(port));
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  std::string out;
  if (connect(s, reinterpret_cast<sockaddr*>(&a), sizeof a) == 0) {
    send(s, request.data(), static_cast<int>(request.size()), 0);
    char buf[512];
    int got;
    while ((got = recv(s, buf, sizeof buf, 0)) > 0) out.append(buf, static_cast<size_t>(got));
  }
  closesocket(s);
  return out;
}

inline std::string post_gsi(int port, const std::string& body) {
  return send_raw(port, "POST /gsi HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: " +
                            std::to_string(body.size()) + "\r\n\r\n" + body);
}
}  // namespace testnet
