#include "core/ogg.h"

namespace sl {
namespace {
const uint32_t* crc_table() {
  static uint32_t t[256];
  static const bool ready = [] {
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t r = i << 24;
      for (int k = 0; k < 8; ++k) r = (r & 0x80000000u) ? (r << 1) ^ 0x04C11DB7u : r << 1;
      t[i] = r;
    }
    return true;
  }();
  (void)ready;
  return t;
}
void put32(std::string& s, uint32_t v) {
  for (int i = 0; i < 4; ++i) s += static_cast<char>((v >> (8 * i)) & 0xFF);
}
void put64(std::string& s, uint64_t v) {
  for (int i = 0; i < 8; ++i) s += static_cast<char>((v >> (8 * i)) & 0xFF);
}
}  // namespace

uint32_t ogg_crc(const uint8_t* d, size_t n) {
  const uint32_t* t = crc_table();
  uint32_t c = 0;
  for (size_t i = 0; i < n; ++i) c = (c << 8) ^ t[((c >> 24) & 0xFF) ^ d[i]];
  return c;
}

void OggWriter::header_packet(const std::string& p) {
  packet(reinterpret_cast<const uint8_t*>(p.data()), p.size(), 0);
  flush();
}

void OggWriter::packet(const uint8_t* d, size_t len, int64_t granule) {
  const size_t segs = len / 255 + 1;
  if (packets_ > 0 && (lacing_.size() + segs > 255 || packets_ >= kPacketsPerPage)) flush();
  for (size_t i = 0; i < len / 255; ++i) lacing_ += static_cast<char>(255);
  lacing_ += static_cast<char>(len % 255);
  body_.append(reinterpret_cast<const char*>(d), len);
  ++packets_;
  granule_ = granule;
}

void OggWriter::flush(bool eos, int64_t granule) {
  if (packets_ == 0 && !eos) return;
  std::string page = "OggS";
  page += '\0';  // version
  uint8_t flags = 0;
  if (first_) flags |= 0x02;
  if (eos) flags |= 0x04;
  page += static_cast<char>(flags);
  put64(page, static_cast<uint64_t>(granule >= 0 ? granule : granule_));
  put32(page, serial_);
  put32(page, seq_++);
  put32(page, 0);  // CRC, calculé sur la page complète
  page += static_cast<char>(lacing_.size());
  page += lacing_;
  page += body_;
  const uint32_t crc = ogg_crc(reinterpret_cast<const uint8_t*>(page.data()), page.size());
  for (int i = 0; i < 4; ++i) page[22 + i] = static_cast<char>((crc >> (8 * i)) & 0xFF);
  out_.write(page.data(), static_cast<std::streamsize>(page.size()));
  out_.flush();  // fichier lisible jusqu'à la dernière page même si TeamSpeak s'arrête net
  first_ = false;
  lacing_.clear();
  body_.clear();
  packets_ = 0;
}
}  // namespace sl
