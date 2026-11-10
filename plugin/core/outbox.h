// File d'envoi sur le disque : une session terminée (session.json présent) attend d'être envoyée ;
// marqueurs sent.json (reçue par Sightline) et failed.json (refusée, renvoi à la main).
#pragma once
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace sl::outbox {
enum class State { Incomplete, Pending, Sent, Failed };
struct Entry {
  std::filesystem::path dir;
  State state;
};
constexpr int64_t kKeepUs = 7LL * 24 * 3600 * 1000000;  // 7 jours

std::vector<Entry> scan(const std::filesystem::path& root);  // du plus ancien au plus récent
// true = marqueur écrit durablement (fichier .part puis renommage)
bool mark_sent(const std::filesystem::path& dir, int64_t now_us, const std::string& response);
bool mark_failed(const std::filesystem::path& dir, int64_t now_us, const std::string& reason);
void reset(const std::filesystem::path& dir);  // à renvoyer
std::optional<std::filesystem::path> latest(const std::filesystem::path& root);  // dernière session terminée
// Supprime les sessions envoyées depuis plus de 7 jours et les enregistrements interrompus (sans session.json)
// commencés depuis plus de 7 jours ; renvoie le nombre de dossiers supprimés
int cleanup(const std::filesystem::path& root, int64_t now_us);
}  // namespace sl::outbox
