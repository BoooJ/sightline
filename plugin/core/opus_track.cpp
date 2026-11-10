#include "core/opus_track.h"

#include <opus.h>

#include <algorithm>
#include <cstring>
#include <string>

#include "core/version.h"

namespace sl {
namespace {
void put16(std::string& s, uint32_t v) {
  s += static_cast<char>(v & 0xFF);
  s += static_cast<char>((v >> 8) & 0xFF);
}
void put32(std::string& s, uint32_t v) {
  put16(s, v & 0xFFFF);
  put16(s, v >> 16);
}
std::string opus_head(int preskip) {
  std::string h = "OpusHead";
  h += static_cast<char>(1);  // version
  h += static_cast<char>(1);  // mono
  put16(h, static_cast<uint32_t>(preskip));
  put32(h, 48000);            // fréquence d'origine
  put16(h, 0);                // gain
  h += static_cast<char>(0);  // famille de canaux 0
  return h;
}
std::string opus_tags() {
  const std::string vendor = std::string("Sightline Comms ") + SIGHTLINE_VERSION;
  std::string t = "OpusTags";
  put32(t, static_cast<uint32_t>(vendor.size()));
  t += vendor;
  put32(t, 0);  // aucun commentaire
  return t;
}
}  // namespace

OpusTrack::~OpusTrack() {
  if (enc_) close();
}

bool OpusTrack::open(const std::filesystem::path& file, uint32_t serial, int bitrate) {
  int err = 0;
  enc_ = opus_encoder_create(kRate, 1, OPUS_APPLICATION_VOIP, &err);
  if (err != OPUS_OK || !enc_) {
    enc_ = nullptr;
    return false;
  }
  opus_encoder_ctl(enc_, OPUS_SET_BITRATE(bitrate));
  opus_encoder_ctl(enc_, OPUS_SET_VBR(1));
  opus_encoder_ctl(enc_, OPUS_SET_DTX(0));  // DTX faite par OpusTrack::silence (la DTX de libopus ajoute du bruit)
  opus_encoder_ctl(enc_, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
  opus_encoder_ctl(enc_, OPUS_SET_COMPLEXITY(5));  // client TeamSpeak 32 bits : rester léger
  opus_int32 lookahead = 0;
  opus_encoder_ctl(enc_, OPUS_GET_LOOKAHEAD(&lookahead));
  preskip_ = static_cast<int>(lookahead);
  file_.open(file, std::ios::binary | std::ios::trunc);
  if (!file_) {
    opus_encoder_destroy(enc_);
    enc_ = nullptr;
    return false;
  }
  ogg_ = std::make_unique<OggWriter>(file_, serial);
  ogg_->header_packet(opus_head(preskip_));
  ogg_->header_packet(opus_tags());
  return static_cast<bool>(file_);
}

void OpusTrack::zero_frame() {
  std::fill(frame_ + fill_, frame_ + kFrame, int16_t(0));
  fill_ = kFrame;
}

void OpusTrack::encode_frame() {
  uint8_t buf[1275];
  opus_int32 len = opus_encode(enc_, frame_, kFrame, buf, sizeof buf);
  if (len < 1) {  // erreur d'encodage : une trame muette plutôt qu'une piste cassée
    buf[0] = kSilenceToc;
    len = 1;
  }
  ++packets_;
  ogg_->packet(buf, static_cast<size_t>(len), static_cast<int64_t>(packets_) * kFrame);
  if (frame_has_sound_) owed_ = kFlushFrames;
  else if (owed_ > 0) --owed_;
  frame_has_sound_ = false;
  fill_ = 0;
}

void OpusTrack::raw_silence() {
  ++packets_;
  ogg_->packet(&kSilenceToc, 1, static_cast<int64_t>(packets_) * kFrame);
}

void OpusTrack::write(const int16_t* pcm, size_t n) {
  if (!enc_) return;
  input_ += n;
  while (n > 0) {
    const size_t take = std::min(n, static_cast<size_t>(kFrame - fill_));
    std::memcpy(frame_ + fill_, pcm, take * sizeof(int16_t));
    fill_ += static_cast<int>(take);
    pcm += take;
    n -= take;
    frame_has_sound_ = true;
    if (fill_ == kFrame) encode_frame();
  }
}

void OpusTrack::silence(uint64_t n) {
  if (!enc_) return;
  input_ += n;
  if (fill_ > 0) {  // compléter la trame en cours
    const uint64_t take = std::min<uint64_t>(n, static_cast<uint64_t>(kFrame - fill_));
    std::fill(frame_ + fill_, frame_ + fill_ + take, int16_t(0));
    fill_ += static_cast<int>(take);
    n -= take;
    if (fill_ == kFrame) encode_frame();
  }
  while (n >= static_cast<uint64_t>(kFrame)) {
    if (owed_ > 0) {
      fill_ = 0;
      zero_frame();
      encode_frame();
    } else {
      raw_silence();
    }
    n -= kFrame;
  }
  if (n > 0) {  // début de la trame suivante
    std::fill(frame_, frame_ + n, int16_t(0));
    fill_ = static_cast<int>(n);
  }
}

bool OpusTrack::close() {
  if (!enc_) return false;
  const uint64_t need = input_ + static_cast<uint64_t>(preskip_);
  if (fill_ > 0) {
    zero_frame();
    encode_frame();
  }
  while (packets_ * kFrame < need) {  // la fin du son est encore dans l'anticipation de l'encodeur
    zero_frame();
    encode_frame();
  }
  ogg_->flush(true, static_cast<int64_t>(need));
  opus_encoder_destroy(enc_);
  enc_ = nullptr;
  ogg_.reset();
  file_.close();
  return !file_.fail();
}
}  // namespace sl
