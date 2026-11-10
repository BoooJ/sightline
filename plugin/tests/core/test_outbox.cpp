#include <chrono>
#include <filesystem>
#include <fstream>
#include <iterator>

#include "check.h"
#include "core/multipart.h"
#include "core/outbox.h"
#include "core/timeutil.h"

namespace fs = std::filesystem;

namespace {
constexpr int64_t DAY = 24LL * 3600 * 1000000;
fs::path make(const fs::path& root, const std::string& name, std::initializer_list<const char*> files) {
  const fs::path d = root / name;
  fs::create_directories(d);
  for (const char* f : files) std::ofstream(d / f, std::ios::binary) << "x";
  return d;
}
std::string read_text(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}
}  // namespace

TEST(outbox_states_latest_and_cleanup) {
  const fs::path root = check::temp_dir("outbox");
  const int64_t now = *sl::parse_folder_stamp("20261025-100000");
  sl::outbox::mark_sent(make(root, "20261001-100000", {"session.json", "t1.ogg"}), now - 10 * DAY, "{}");
  make(root, "20261010-100000", {"t1.ogg"});  // enregistrement interrompu il y a 15 jours
  sl::outbox::mark_sent(make(root, "20261020-100000", {"session.json"}), now - DAY, "{\"status\":\"waiting\"}");
  make(root, "20261021-100000", {"session.json"});
  sl::outbox::mark_failed(make(root, "20261022-100000", {"session.json"}), now, "map invalide");
  make(root, "20261024-100000", {"t1.ogg"});  // en cours
  const auto all = sl::outbox::scan(root);
  CHECK_EQ(all.size(), size_t(6));
  if (all.size() == 6) {
    CHECK(all[0].state == sl::outbox::State::Sent);
    CHECK(all[1].state == sl::outbox::State::Incomplete);
    CHECK(all[2].state == sl::outbox::State::Sent);
    CHECK(all[3].state == sl::outbox::State::Pending);
    CHECK(all[4].state == sl::outbox::State::Failed);
    CHECK(all[5].state == sl::outbox::State::Incomplete);
  }
  const auto last = sl::outbox::latest(root);
  CHECK(last && last->filename().u8string() == "20261022-100000");
  CHECK_EQ(sl::outbox::cleanup(root, now), 2);
  CHECK(!fs::exists(root / "20261001-100000"));
  CHECK(!fs::exists(root / "20261010-100000"));
  CHECK(fs::exists(root / "20261020-100000"));
  CHECK(fs::exists(root / "20261024-100000"));
  sl::outbox::reset(root / "20261022-100000");
  CHECK(sl::outbox::scan(root)[2].state == sl::outbox::State::Pending);
  sl::outbox::mark_sent(root / "20261021-100000", now, "{\"status\":\"attached\"}");
  CHECK(read_text(root / "20261021-100000" / "sent.json").find("attached") != std::string::npos);
}

TEST(multipart_body_matches_the_server_contract) {
  const fs::path dir = check::temp_dir("multipart");
  const std::string json = "{\"tracks\":[{\"file\":\"t1.ogg\"},{\"file\":\"t2.ogg\"}]}";
  std::ofstream(dir / "session.json", std::ios::binary) << json;
  std::ofstream(dir / "t1.ogg", std::ios::binary) << "OggS-1";
  std::ofstream(dir / "t2.ogg", std::ios::binary) << "OggS-22";
  sl::Multipart mp;
  std::string err;
  CHECK(sl::build_session_upload(dir, "B", mp, err));
  std::string body;
  for (const sl::Segment& s : mp.segments) body += s.file.empty() ? s.bytes : read_text(s.file);
  CHECK_EQ(body, std::string("--B\r\nContent-Disposition: form-data; name=\"session\"\r\n"
                             "Content-Type: application/json\r\n\r\n") + json +
                     "\r\n--B\r\nContent-Disposition: form-data; name=\"files\"; filename=\"t1.ogg\"\r\n"
                     "Content-Type: audio/ogg\r\n\r\nOggS-1\r\n"
                     "--B\r\nContent-Disposition: form-data; name=\"files\"; filename=\"t2.ogg\"\r\n"
                     "Content-Type: audio/ogg\r\n\r\nOggS-22\r\n--B--\r\n");
  CHECK_EQ(mp.total_size(), uint64_t(body.size()));
  CHECK_EQ(mp.content_type(), std::string("multipart/form-data; boundary=B"));
  fs::remove(dir / "t2.ogg");
  CHECK(!sl::build_session_upload(dir, "B", mp, err));
  CHECK_EQ(err, std::string("piste absente : t2.ogg"));
  std::ofstream(dir / "session.json", std::ios::binary | std::ios::trunc) << "{\"tracks\":[{\"file\":\"../x\"}]}";
  CHECK(!sl::build_session_upload(dir, "B", mp, err));
  fs::remove(dir / "session.json");
  CHECK(!sl::build_session_upload(dir, "B", mp, err));
}

TEST(segments_size_saturates_on_unreadable_file) {
  std::vector<sl::Segment> segs;
  segs.push_back({"abc", {}});
  segs.push_back({{}, check::temp_dir("seg") / "absent.ogg"});
  CHECK_EQ(sl::segments_size(segs), UINT64_MAX);
}

TEST(outbox_mark_write_failure_and_normal_case) {
  const fs::path root = check::temp_dir("outbox_mark");
  const fs::path ok = make(root, "20261001-100000", {"session.json"});
  CHECK(sl::outbox::mark_sent(ok, 5, "{}"));
  CHECK(fs::exists(ok / "sent.json"));
  CHECK(!fs::exists(ok / "sent.json.part"));
  CHECK(sl::outbox::mark_failed(make(root, "20261002-100000", {"session.json"}), 5, "x"));
  CHECK(!fs::exists(root / "20261002-100000" / "failed.json.part"));
  const fs::path ghost = root / "absent";  // le dossier n'existe pas
  CHECK(!sl::outbox::mark_sent(ghost, 5, "{}"));
  CHECK(!sl::outbox::mark_failed(ghost, 5, "x"));
  const fs::path pend = make(root, "20261003-100000", {"session.json"});
  fs::create_directories(pend / "sent.json");  // un dossier occupe le nom : le renommage échoue
  CHECK(!sl::outbox::mark_sent(pend, 5, "{}"));
  CHECK(!fs::exists(pend / "sent.json.part"));
}

TEST(outbox_cleanup_uses_mtime_when_sent_json_is_unusable) {
  const fs::path root = check::temp_dir("outbox_mtime");
  const int64_t now = std::chrono::duration_cast<std::chrono::microseconds>(
                          std::chrono::system_clock::now().time_since_epoch()).count();
  const fs::path old_dir = make(root, "20261020-100000", {"session.json"});
  const fs::path new_dir = make(root, "20261021-100000", {"session.json"});
  std::ofstream(old_dir / "sent.json", std::ios::binary) << "{";
  std::ofstream(new_dir / "sent.json", std::ios::binary) << "{";
  fs::last_write_time(old_dir / "sent.json", fs::file_time_type::clock::now() - std::chrono::hours(24 * 30));
  CHECK_EQ(sl::outbox::cleanup(root, now), 1);
  CHECK(!fs::exists(old_dir));
  CHECK(fs::exists(new_dir));
}
