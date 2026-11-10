#include <sstream>

#include "check.h"
#include "core/ogg.h"
#include "core/opus_track.h"
#include "ogg_read.h"

TEST(ogg_crc_lacing_and_pages) {
  const char* s = "123456789";
  CHECK_EQ(sl::ogg_crc(reinterpret_cast<const uint8_t*>(s), 9), 0x89A1897Fu);
  std::ostringstream out;
  sl::OggWriter w(out, 7);
  w.header_packet("OpusHead-test");
  const std::string big(600, 'x'), exact(255, 'y');
  w.packet(reinterpret_cast<const uint8_t*>(big.data()), big.size(), 960);
  w.packet(reinterpret_cast<const uint8_t*>(exact.data()), exact.size(), 1920);  // 255 octets : segment 255 puis 0
  w.flush(true);
  const testogg::OggFile o = testogg::read_bytes(out.str());
  CHECK(o.ok);
  CHECK_EQ(o.packets.size(), size_t(3));
  if (o.packets.size() == 3) {
    CHECK_EQ(o.packets[0], std::string("OpusHead-test"));
    CHECK_EQ(o.packets[1], big);
    CHECK_EQ(o.packets[2], exact);
  }
  CHECK_EQ(o.granules.size(), size_t(2));
  CHECK_EQ(o.last_granule, int64_t(1920));
  CHECK_EQ(int(o.flags.front()), 2);
  CHECK_EQ(int(o.flags.back()), 4);
  // 120 paquets : pages de 50, 50 puis 20 (après celle d'en-tête)
  std::ostringstream out2;
  sl::OggWriter w2(out2, 8);
  w2.header_packet("h");
  const std::string p(60, 'p');
  for (int k = 1; k <= 120; ++k) w2.packet(reinterpret_cast<const uint8_t*>(p.data()), p.size(), k * 960LL);
  w2.flush(true, 99);
  const testogg::OggFile o2 = testogg::read_bytes(out2.str());
  CHECK(o2.ok);
  CHECK_EQ(o2.granules.size(), size_t(4));
  if (o2.granules.size() == 4) {
    CHECK_EQ(o2.granules[1], int64_t(50 * 960));
    CHECK_EQ(o2.granules[2], int64_t(100 * 960));
    CHECK_EQ(o2.granules[3], int64_t(99));  // granule imposé sur la dernière page
  }
}

TEST(opus_track_keeps_sound_and_silence_in_place) {
  const auto dir = check::temp_dir("opus");
  const auto file = dir / "t1.ogg";
  sl::OpusTrack t;
  CHECK(t.open(file, 1234));
  const std::vector<int16_t> a = testogg::sine(24000, 440);  // 0,5 s
  t.write(a.data(), 1000);  // morceaux irréguliers
  t.write(a.data() + 1000, a.size() - 1000);
  t.silence(48000);  // 1 s
  t.write(a.data(), a.size());
  CHECK_EQ(t.position(), uint64_t(96000));
  const int preskip = t.preskip();
  CHECK(preskip > 0 && preskip < 960);
  CHECK(t.close());
  const testogg::OggFile o = testogg::read_ogg(file);
  CHECK(o.ok);
  CHECK(o.packets.size() > 50);
  if (o.packets.size() < 3) return;
  CHECK(o.packets[0].compare(0, 8, "OpusHead") == 0);
  CHECK_EQ(int(static_cast<uint8_t>(o.packets[0][9])), 1);  // mono
  CHECK_EQ(static_cast<uint8_t>(o.packets[0][10]) | (static_cast<uint8_t>(o.packets[0][11]) << 8), preskip);
  CHECK(o.packets[1].compare(0, 8, "OpusTags") == 0);
  CHECK_EQ(int(o.flags.front() & 2), 2);
  CHECK_EQ(int(o.flags.back() & 4), 4);
  CHECK_EQ(o.last_granule, int64_t(preskip + 96000));
  size_t tiny = 0;
  for (size_t k = 2; k < o.packets.size(); ++k) tiny += o.packets[k].size() <= 2;
  CHECK(tiny >= 20);  // au-delà de 500 ms de silence, une trame muette coûte un octet
  const std::vector<int16_t> pcm = testogg::decode(o);
  CHECK_EQ(pcm.size(), size_t(96000));
  CHECK(testogg::rms(pcm, 0.05, 0.45) > 2000);
  CHECK(testogg::rms(pcm, 0.6, 1.4) < 200);
  CHECK(testogg::peak(pcm, 0.6, 1.45) < 500);
  CHECK(testogg::rms(pcm, 1.55, 1.95) > 2000);
}

TEST(opus_track_long_silence_after_speech_stays_silent) {
  // Régression du 25/10 : des trames vides juste après la voix étaient décodées en bruit de confort
  const auto dir = check::temp_dir("opus3");
  sl::OpusTrack t;
  CHECK(t.open(dir / "t.ogg", 2));
  const std::vector<int16_t> a = testogg::sine(48000, 440);  // 1 s de son stable
  t.write(a.data(), a.size());
  t.silence(48000 * 5);
  CHECK(t.close());
  const std::vector<int16_t> pcm = testogg::decode(testogg::read_ogg(dir / "t.ogg"));
  CHECK_EQ(pcm.size(), size_t(48000 * 6));
  CHECK(testogg::rms(pcm, 0.1, 0.95) > 2000);  // la voix reste forte jusqu'au bout (pas de DTX de libopus)
  CHECK(testogg::peak(pcm, 1.1, 6.0) < 300);
}

TEST(opus_track_starting_with_silence) {
  const auto dir = check::temp_dir("opus2");
  sl::OpusTrack t;
  CHECK(t.open(dir / "t.ogg", 1));
  t.silence(48000 * 3 + 123);  // la voix arrive après 3 s
  const std::vector<int16_t> a = testogg::sine(9600, 660);
  t.write(a.data(), a.size());
  CHECK(t.close());
  const std::vector<int16_t> pcm = testogg::decode(testogg::read_ogg(dir / "t.ogg"));
  CHECK_EQ(pcm.size(), size_t(48000 * 3 + 123 + 9600));
  CHECK(testogg::rms(pcm, 0.0, 2.95) < 50);
  CHECK(testogg::rms(pcm, 3.03, 3.18) > 2000);
}
