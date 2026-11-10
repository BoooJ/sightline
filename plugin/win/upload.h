// Envoi d'une session terminée à Sightline : contrôle de la clé d'abord (un refus arrive avant d'envoyer des Mo),
// puis le multipart ; la file d'envoi est marquée selon la réponse.
#pragma once
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <string>

namespace sl::win {
// Sent : reçue (sent.json) ; Rejected : refusée par Sightline (failed.json, renvoi par le menu) ;
// Settings : adresse ou clé à corriger (rien de marqué) ; Retry : réseau ou serveur indisponible (rien de marqué)
enum class Outcome { Sent, Rejected, Settings, Retry };
struct UploadResult {
  Outcome outcome = Outcome::Retry;
  int status = 0;
  std::string message;
};
enum class KeyCheck { Ok, Refused, Unreachable };
struct KeyResult {
  KeyCheck check = KeyCheck::Unreachable;
  std::string message;
};
constexpr uint64_t kMaxUploadBytes = 200ull * 1024 * 1024;  // comms.MAX_BYTES côté Sightline

// POST vide : 400 « session : JSON attendu » = clé acceptée ; 401 inconnue ; 403 sans la portée comms
KeyResult check_key(const std::string& site, const std::string& key, const std::atomic<bool>* cancel = nullptr);
UploadResult upload_session(const std::filesystem::path& dir, const std::string& site, const std::string& key,
                            int64_t now_us, const std::atomic<bool>* cancel = nullptr);
std::string server_detail(const std::string& body);  // champ "detail" d'une erreur de Sightline
}  // namespace sl::win
