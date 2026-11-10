// Corps multipart/form-data de l'envoi d'une session : champ `session` (JSON) + un champ `files` par piste.
// Les pistes sont lues sur le disque pendant l'envoi : jamais toute la session en mémoire (client TeamSpeak 32 bits).
#pragma once
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace sl {
struct Segment {
  std::string bytes;           // octets…
  std::filesystem::path file;  // …ou contenu de ce fichier s'il est indiqué
};
uint64_t segments_size(const std::vector<Segment>& segments);
struct Multipart {
  std::string boundary;
  std::vector<Segment> segments;
  std::string content_type() const { return "multipart/form-data; boundary=" + boundary; }
  uint64_t total_size() const { return segments_size(segments); }
};
// Lit dir/session.json et joint chaque piste qu'il annonce ; false + raison si la session est inutilisable
bool build_session_upload(const std::filesystem::path& dir, const std::string& boundary, Multipart& out,
                          std::string& error);
}  // namespace sl
