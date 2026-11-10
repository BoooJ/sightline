#include "core/block_queue.h"

#include <algorithm>
#include <cstring>

namespace sl {
BlockQueue::BlockQueue(size_t capacity) : ring_(std::max<size_t>(capacity, 1)) {}

void BlockQueue::push(uint64_t schid, uint16_t client, bool self, int64_t wall_us, const short* samples, int frames,
                      int channels) {
  if (!samples || frames <= 0 || channels <= 0) return;
  int16_t mono[960];
  for (int off = 0; off < frames; off += 960) {
    const int n = std::min(960, frames - off);
    for (int i = 0; i < n; ++i) {
      int sum = 0;
      for (int c = 0; c < channels; ++c) sum += samples[(off + i) * channels + c];
      mono[i] = static_cast<int16_t>(sum / channels);
    }
    const int64_t at = wall_us + static_cast<int64_t>(off) * 1000000 / 48000;
    std::lock_guard<std::mutex> l(mx_);
    if (count_ == ring_.size()) {
      dropped_.fetch_add(1);
      continue;
    }
    VoiceBlock& b = ring_[(head_ + count_) % ring_.size()];
    b.schid = schid;
    b.client = client;
    b.self = self;
    b.wall_us = at;
    b.frames = static_cast<uint16_t>(n);
    std::memcpy(b.pcm, mono, static_cast<size_t>(n) * sizeof(int16_t));
    ++count_;
  }
}

bool BlockQueue::pop(VoiceBlock& out) {
  std::lock_guard<std::mutex> l(mx_);
  if (count_ == 0) return false;
  out = ring_[head_];
  head_ = (head_ + 1) % ring_.size();
  --count_;
  return true;
}

void BlockQueue::clear() {
  std::lock_guard<std::mutex> l(mx_);
  head_ = count_ = 0;
}
}  // namespace sl
