// Une piste : son 48 kHz mono → fichier Ogg Opus (RFC 7845) écrit au fil de l'eau, 24 kbit/s.
// DTX faite ici : au-delà de 500 ms de silence encodé, un paquet d'un octet (trame vide de 20 ms) par trame muette.
#pragma once
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>

#include "core/ogg.h"

struct OpusEncoder;

namespace sl {
class OpusTrack {
 public:
  static constexpr int kRate = 48000;
  static constexpr int kFrame = 960;            // 20 ms
  static constexpr uint8_t kSilenceToc = 0xF8;  // CELT plein bande 20 ms, trame de 0 octet (trame « perdue »)
  static constexpr int kFlushFrames = 25;       // 500 ms de zéros encodés après la voix, avant les trames vides
  OpusTrack() = default;
  ~OpusTrack();
  OpusTrack(const OpusTrack&) = delete;
  OpusTrack& operator=(const OpusTrack&) = delete;
  bool open(const std::filesystem::path& file, uint32_t serial, int bitrate_bps = 24000);
  void write(const int16_t* pcm, size_t n);  // son réel
  void silence(uint64_t n);                   // n échantillons de silence
  uint64_t position() const { return input_; }  // échantillons reçus (son + silence)
  int preskip() const { return preskip_; }
  bool close();  // vide l'encodeur, page de fin ; false si une écriture a échoué
  bool is_open() const { return enc_ != nullptr; }

 private:
  void zero_frame();
  void encode_frame();
  void raw_silence();
  std::ofstream file_;
  std::unique_ptr<OggWriter> ogg_;
  OpusEncoder* enc_ = nullptr;
  int preskip_ = 0;
  int16_t frame_[kFrame] = {};
  int fill_ = 0;
  bool frame_has_sound_ = false;
  int owed_ = 0;          // trames muettes à passer encore par l'encodeur (cf. kFlushFrames)
  uint64_t input_ = 0;
  uint64_t packets_ = 0;  // paquets écrits, 20 ms chacun
};
}  // namespace sl
