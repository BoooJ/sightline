// Écriture d'un flux Ogg (RFC 3533) : pages de 255 segments au plus, CRC, granule du dernier paquet complet.
#pragma once
#include <cstddef>
#include <cstdint>
#include <ostream>
#include <string>

namespace sl {
uint32_t ogg_crc(const uint8_t* data, size_t len);

class OggWriter {
 public:
  static constexpr size_t kPacketsPerPage = 50;  // une page par seconde de son (trames de 20 ms)
  OggWriter(std::ostream& out, uint32_t serial) : out_(out), serial_(serial) {}
  // Paquet d'en-tête (OpusHead, OpusTags) : seul sur sa page, granule 0 ; la toute première page porte BOS
  void header_packet(const std::string& packet);
  // Paquet audio ; `granule` = position (échantillons, pré-skip compris) à la fin de ce paquet.
  // La page en cours n'est écrite qu'à l'arrivée du paquet suivant : la dernière n'est jamais vide.
  void packet(const uint8_t* data, size_t len, int64_t granule);
  // Écrit la page en cours ; `eos` pour la dernière ; `granule` (≥ 0) remplace celui de la page (rognage de fin)
  void flush(bool eos = false, int64_t granule = -1);

 private:
  std::ostream& out_;
  uint32_t serial_;
  uint32_t seq_ = 0;
  bool first_ = true;
  std::string body_, lacing_;
  size_t packets_ = 0;
  int64_t granule_ = 0;
};
}  // namespace sl
