#include <vector>

#include "check.h"
#include "core/block_queue.h"

TEST(block_queue_mixes_to_mono_and_splits_by_20ms) {
  sl::BlockQueue q(8);
  std::vector<short> stereo(1500 * 2);
  for (int i = 0; i < 1500; ++i) {
    stereo[2 * i] = 1000;
    stereo[2 * i + 1] = 3000;
  }
  q.push(1, 9, false, 5000000, stereo.data(), 1500, 2);
  sl::VoiceBlock b;
  CHECK(q.pop(b));
  CHECK_EQ(int(b.frames), 960);
  CHECK_EQ(b.wall_us, int64_t(5000000));
  CHECK_EQ(int(b.pcm[0]), 2000);
  CHECK_EQ(int(b.client), 9);
  CHECK_EQ(b.schid, uint64_t(1));
  CHECK(!b.self);
  CHECK(q.pop(b));
  CHECK_EQ(int(b.frames), 540);
  CHECK_EQ(b.wall_us, int64_t(5020000));  // deuxième bloc : 20 ms plus tard
  CHECK_EQ(int(b.pcm[539]), 2000);
  CHECK(!q.pop(b));
}

TEST(block_queue_drops_when_full_and_ignores_empty_input) {
  sl::BlockQueue q(2);
  short mono[960] = {};
  for (int i = 0; i < 3; ++i) q.push(1, 0, true, i, mono, 960, 1);
  CHECK_EQ(q.dropped(), uint64_t(1));
  sl::VoiceBlock b;
  CHECK(q.pop(b) && b.wall_us == 0);
  CHECK(q.pop(b) && b.wall_us == 1);
  CHECK(!q.pop(b));
  q.push(1, 0, true, 7, nullptr, 960, 1);
  q.push(1, 0, true, 7, mono, 0, 1);
  CHECK(!q.pop(b));
}
