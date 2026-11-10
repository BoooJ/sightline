// Passage des blocs de voix du fil audio de TeamSpeak au fil d'encodage. Côté audio : jamais d'attente longue
// (un verrou le temps d'une copie de 2 Ko) ; file pleine → bloc perdu, compté.
#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <vector>

namespace sl {
struct VoiceBlock {
  uint64_t schid = 0;   // onglet de serveur TeamSpeak
  uint16_t client = 0;  // clientID (0 pour le micro de l'enregistreur)
  bool self = false;
  int64_t wall_us = 0;  // heure murale du premier échantillon
  uint16_t frames = 0;  // 960 au plus
  int16_t pcm[960];
};

class BlockQueue {
 public:
  explicit BlockQueue(size_t capacity = 1024);
  // `samples` entrelacés sur `channels` voies, 48 kHz : mixés en mono et découpés en blocs de 20 ms
  void push(uint64_t schid, uint16_t client, bool self, int64_t wall_us, const short* samples, int frames,
            int channels);
  bool pop(VoiceBlock& out);
  uint64_t dropped() const { return dropped_.load(); }
  void clear();

 private:
  std::vector<VoiceBlock> ring_;
  size_t head_ = 0, count_ = 0;
  std::mutex mx_;
  std::atomic<uint64_t> dropped_{0};
};
}  // namespace sl
