// Écoute HTTP locale (127.0.0.1 seulement) des messages GSI de CS2 : POST seulement, corps de 64 Ko au plus.
// La réponse part avant l'appel du gestionnaire : CS2 n'attend jamais le plugin.
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>

namespace sl::win {
class GsiServer {
 public:
  static constexpr size_t kMaxBody = 65536;
  using Handler = std::function<void(const std::string& body)>;
  GsiServer() = default;
  ~GsiServer() { stop(); }
  GsiServer(const GsiServer&) = delete;
  GsiServer& operator=(const GsiServer&) = delete;
  bool start(int port, Handler on_body, std::string& error);
  void stop();

 private:
  void loop();
  void serve(uintptr_t client);
  uintptr_t sock_ = ~uintptr_t(0);  // SOCKET
  bool winsock_ = false;
  std::thread thread_;
  std::atomic<bool> stop_{false};
  Handler on_body_;
};
}  // namespace sl::win
