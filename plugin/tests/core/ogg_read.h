// Lecture d'un fichier Ogg Opus pour les tests : pages (CRC vérifié), paquets, décodage avec libopus.
#pragma once
#include <opus.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "core/ogg.h"

namespace testogg {
struct OggFile {
  bool ok = true;
  std::string error;
  std::vector<std::string> packets;
  std::vector<int64_t> granules;  // une valeur par page
  std::vector<uint8_t> flags;     // une valeur par page (2 = BOS, 4 = EOS)
  int64_t last_granule = -1;
};

inline OggFile read_bytes(const std::string& data) {
  OggFile o;
  size_t i = 0;
  std::string partial;
  while (i < data.size()) {
    if (data.size() - i < 27 || data.compare(i, 4, "OggS") != 0) {
      o.ok = false;
      o.error = "OggS attendu";
      return o;
    }
    const uint8_t flags = static_cast<uint8_t>(data[i + 5]);
    int64_t granule = 0;
    for (int k = 7; k >= 0; --k) granule = (granule << 8) | static_cast<uint8_t>(data[i + 6 + k]);
    uint32_t crc = 0;
    for (int k = 3; k >= 0; --k) crc = (crc << 8) | static_cast<uint8_t>(data[i + 22 + k]);
    const size_t nseg = static_cast<uint8_t>(data[i + 26]);
    size_t body = 0;
    for (size_t k = 0; k < nseg; ++k) body += static_cast<uint8_t>(data[i + 27 + k]);
    const size_t size = 27 + nseg + body;
    std::string page = data.substr(i, size);
    for (int k = 0; k < 4; ++k) page[22 + k] = 0;
    if (sl::ogg_crc(reinterpret_cast<const uint8_t*>(page.data()), page.size()) != crc) {
      o.ok = false;
      o.error = "CRC faux";
      return o;
    }
    size_t pos = i + 27 + nseg;
    for (size_t k = 0; k < nseg; ++k) {
      const uint8_t len = static_cast<uint8_t>(data[i + 27 + k]);
      partial.append(data, pos, len);
      pos += len;
      if (len < 255) {
        o.packets.push_back(partial);
        partial.clear();
      }
    }
    o.flags.push_back(flags);
    o.granules.push_back(granule);
    o.last_granule = granule;
    i += size;
  }
  return o;
}

inline OggFile read_ogg(const std::filesystem::path& p) {
  std::ifstream f(p, std::ios::binary);
  return read_bytes(std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>()));
}

// PCM décodé, pré-skip retiré, rogné au granule de la dernière page
inline std::vector<int16_t> decode(const OggFile& o) {
  std::vector<int16_t> pcm;
  if (o.packets.size() < 3) return pcm;
  const int preskip = static_cast<uint8_t>(o.packets[0][10]) | (static_cast<uint8_t>(o.packets[0][11]) << 8);
  int err = 0;
  OpusDecoder* dec = opus_decoder_create(48000, 1, &err);
  std::vector<int16_t> buf(5760);
  for (size_t k = 2; k < o.packets.size(); ++k) {
    const int n = opus_decode(dec, reinterpret_cast<const unsigned char*>(o.packets[k].data()),
                              static_cast<opus_int32>(o.packets[k].size()), buf.data(), 5760, 0);
    if (n > 0) pcm.insert(pcm.end(), buf.begin(), buf.begin() + n);
  }
  opus_decoder_destroy(dec);
  pcm.erase(pcm.begin(), pcm.begin() + std::min<size_t>(pcm.size(), static_cast<size_t>(preskip)));
  pcm.resize(std::min<size_t>(pcm.size(), static_cast<size_t>(o.last_granule - preskip)));
  return pcm;
}

inline double rms(const std::vector<int16_t>& p, double from_s, double to_s) {
  const size_t a = static_cast<size_t>(from_s * 48000);
  const size_t b = std::min(p.size(), static_cast<size_t>(to_s * 48000));
  double s = 0;
  for (size_t i = a; i < b; ++i) s += static_cast<double>(p[i]) * p[i];
  return b > a ? std::sqrt(s / static_cast<double>(b - a)) : 0;
}

// Crête (valeur absolue maximale) entre deux instants : un bruit de confort se voit ici, pas dans la moyenne
inline int peak(const std::vector<int16_t>& p, double from_s, double to_s) {
  const size_t a = static_cast<size_t>(from_s * 48000);
  const size_t b = std::min(p.size(), static_cast<size_t>(to_s * 48000));
  int m = 0;
  for (size_t i = a; i < b; ++i) m = std::max(m, std::abs(static_cast<int>(p[i])));
  return m;
}

// Sinus de `n` échantillons à `hz`, amplitude 8000
inline std::vector<int16_t> sine(size_t n, double hz, size_t offset = 0) {
  std::vector<int16_t> v(n);
  for (size_t i = 0; i < n; ++i)
    v[i] = static_cast<int16_t>(8000 * std::sin(2 * 3.14159265358979 * hz * static_cast<double>(offset + i) / 48000.0));
  return v;
}
}  // namespace testogg
