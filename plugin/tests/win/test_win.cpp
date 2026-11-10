#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <thread>
#include <vector>

#include "check.h"
#include "core/outbox.h"
#include "gsi_json.h"
#include "net_client.h"
#include "win/clock.h"
#include "win/gsi_server.h"
#include "win/secret.h"
#include "win/steam_paths.h"
#include "win/text.h"
#include "win/upload.h"

namespace fs = std::filesystem;

TEST(clock_is_utc_wall_time) {
  const int64_t now = sl::win::now_us();
  CHECK(std::llabs(now / 1000000 - static_cast<long long>(std::time(nullptr))) <= 2);
  CHECK(sl::win::now_us() >= now);
}

TEST(text_conversions_round_trip) {
  const std::string s = "Invité \xF0\x9F\x98\x80";
  CHECK_EQ(sl::win::narrow(sl::win::widen(s)), s);
  CHECK(sl::win::widen("").empty());
}

TEST(secret_round_trip_for_this_windows_account) {
  const fs::path dir = check::temp_dir("secret");
  CHECK(sl::win::save_secret(dir / "key.bin", "sl_secret-é"));
  CHECK(sl::win::load_secret(dir / "key.bin") == std::optional<std::string>("sl_secret-é"));
  std::ifstream f(dir / "key.bin", std::ios::binary);
  const std::string raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  f.close();
  CHECK(raw.find("sl_secret") == std::string::npos);  // chiffré sur le disque
  std::ofstream(dir / "key.bin", std::ios::binary | std::ios::trunc) << "abimé";
  CHECK(!sl::win::load_secret(dir / "key.bin"));
  CHECK(!sl::win::load_secret(dir / "absent.bin"));
}

TEST(gsi_server_accepts_posts_only) {
  testnet::Winsock ws;
  sl::win::GsiServer srv;
  std::mutex mx;
  std::vector<std::string> got;
  std::string err;
  CHECK(srv.start(47899, [&](const std::string& b) {
    std::lock_guard<std::mutex> l(mx);
    got.push_back(b);
  }, err));
  const std::string body = testgsi::map("jeton", "live", "live", 0, 0, 0);
  CHECK(testnet::post_gsi(47899, body).rfind("HTTP/1.1 200", 0) == 0);
  CHECK(testnet::send_raw(47899, "GET / HTTP/1.1\r\nHost: x\r\n\r\n").rfind("HTTP/1.1 405", 0) == 0);
  CHECK(testnet::send_raw(47899, "POST / HTTP/1.1\r\nContent-Length: 999999\r\n\r\n").rfind("HTTP/1.1 413", 0) == 0);
  {
    std::lock_guard<std::mutex> l(mx);
    CHECK_EQ(got.size(), size_t(1));
    if (!got.empty()) CHECK_EQ(got[0], body);
  }
  sl::win::GsiServer other;
  CHECK(!other.start(47899, [](const std::string&) {}, err));  // port déjà pris
  CHECK(!err.empty());
  srv.stop();
  CHECK(other.start(47899, [](const std::string&) {}, err));  // libéré aussitôt (redémarrage de TeamSpeak)
  other.stop();
}

TEST(steam_lookup_lists_existing_cfg_dirs) {
  for (const fs::path& d : sl::win::find_cs2_cfg_dirs()) {
    std::printf("  CS2 : %s\n", d.u8string().c_str());
    CHECK(fs::is_directory(d));
  }
}

TEST(key_check_and_upload_without_server) {
  CHECK(sl::win::check_key("pas une adresse", "sl_x").check == sl::win::KeyCheck::Refused);
  CHECK(sl::win::check_key("http://127.0.0.1:9", "pas-une-cle").check == sl::win::KeyCheck::Refused);
  const sl::win::KeyResult k = sl::win::check_key("http://127.0.0.1:9", "sl_abc");  // rien n'écoute sur le port 9
  CHECK(k.check == sl::win::KeyCheck::Unreachable);
  CHECK(!k.message.empty());
  const fs::path dir = check::temp_dir("upload");
  std::ofstream(dir / "session.json", std::ios::binary) << "{\"tracks\":[{\"file\":\"t1.ogg\"}]}";
  std::ofstream(dir / "t1.ogg", std::ios::binary) << "OggS";
  CHECK(sl::win::upload_session(dir, "http://127.0.0.1:9", "sl_abc", 0).outcome == sl::win::Outcome::Retry);
  CHECK(sl::win::upload_session(dir, "http://127.0.0.1:9", "", 0).outcome == sl::win::Outcome::Settings);
  CHECK(!fs::exists(dir / "sent.json") && !fs::exists(dir / "failed.json"));  // rien de marqué : nouvel essai plus tard
  CHECK_EQ(sl::win::server_detail("{\"detail\":\"map invalide\"}"), std::string("map invalide"));
}

namespace {
// Faux serveur Sightline sur 127.0.0.1 (port éphémère) : enregistre chaque requête et répond selon la liste
// (la dernière réponse sert pour les requêtes suivantes) ; statut 0 = accepte et ne répond jamais.
struct FakeResponse {
  int status;
  std::string body;
};
struct FakeRequest {
  std::string method, path, authorization, body;
};
class FakeServer {
 public:
  explicit FakeServer(std::vector<FakeResponse> responses) : responses_(std::move(responses)) {
    s_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = 0;
    inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    bind(s_, reinterpret_cast<sockaddr*>(&a), sizeof a);
    listen(s_, 8);
    int len = sizeof a;
    getsockname(s_, reinterpret_cast<sockaddr*>(&a), &len);
    port_ = ntohs(a.sin_port);
    th_ = std::thread([this] { run(); });
  }
  ~FakeServer() {
    stop_ = true;
    th_.join();
    for (SOCKET c : held_) closesocket(c);
    closesocket(s_);
  }
  std::string url() const { return "http://127.0.0.1:" + std::to_string(port_); }
  std::vector<FakeRequest> requests() {
    std::lock_guard<std::mutex> l(mx_);
    return seen_;
  }

 private:
  void run() {
    while (!stop_) {
      fd_set set;
      FD_ZERO(&set);
      FD_SET(s_, &set);
      timeval tv{0, 50000};
      if (select(0, &set, nullptr, nullptr, &tv) <= 0) continue;
      SOCKET c = accept(s_, nullptr, nullptr);
      if (c == INVALID_SOCKET) continue;
      serve(c);
    }
  }
  void serve(SOCKET c) {
    DWORD timeout = 3000;
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof timeout);
    std::string data;
    char buf[8192];
    size_t end;
    while ((end = data.find("\r\n\r\n")) == std::string::npos) {
      int got = recv(c, buf, sizeof buf, 0);
      if (got <= 0) {
        closesocket(c);
        return;
      }
      data.append(buf, static_cast<size_t>(got));
    }
    const std::string head = data.substr(0, end);
    FakeRequest r;
    r.method = head.substr(0, head.find(' '));
    const size_t p1 = head.find(' ') + 1;
    r.path = head.substr(p1, head.find(' ', p1) - p1);
    std::string low = head;
    for (char& ch : low) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    auto header = [&](const std::string& name) {
      const size_t at = low.find("\r\n" + name + ":");
      if (at == std::string::npos) return std::string();
      size_t b = at + 3 + name.size();
      while (b < head.size() && head[b] == ' ') ++b;
      return head.substr(b, head.find("\r\n", b) - b);
    };
    r.authorization = header("authorization");
    const std::string cl = header("content-length");
    const size_t want = cl.empty() ? 0 : static_cast<size_t>(std::stoull(cl));
    std::string body = data.substr(end + 4);
    while (body.size() < want) {
      int got = recv(c, buf, sizeof buf, 0);
      if (got <= 0) break;
      body.append(buf, static_cast<size_t>(got));
    }
    r.body = body;
    size_t n;
    {
      std::lock_guard<std::mutex> l(mx_);
      seen_.push_back(r);
      n = seen_.size() - 1;
    }
    const FakeResponse& resp = responses_[std::min(n, responses_.size() - 1)];
    if (resp.status == 0) {
      held_.push_back(c);
      return;
    }
    const std::string out = "HTTP/1.1 " + std::to_string(resp.status) + " X\r\nContent-Type: application/json\r\n"
                            "Content-Length: " + std::to_string(resp.body.size()) + "\r\nConnection: close\r\n\r\n" +
                            resp.body;
    send(c, out.data(), static_cast<int>(out.size()), 0);
    closesocket(c);
  }
  std::vector<FakeResponse> responses_;
  SOCKET s_;
  int port_ = 0;
  std::thread th_;
  std::atomic<bool> stop_{false};
  std::mutex mx_;
  std::vector<FakeRequest> seen_;
  std::vector<SOCKET> held_;
};

const FakeResponse kKeyOk{400, "{\"detail\":\"session : JSON attendu\"}"};

fs::path make_session(const std::string& name) {
  const fs::path dir = check::temp_dir(name);
  std::ofstream(dir / "session.json", std::ios::binary) << "{\"tracks\":[{\"file\":\"t1.ogg\"}]}";
  std::ofstream(dir / "t1.ogg", std::ios::binary) << "OggS";
  return dir;
}
}  // namespace

TEST(check_key_posts_empty_with_authorization) {
  testnet::Winsock ws;
  FakeServer srv({kKeyOk});
  const sl::win::KeyResult k = sl::win::check_key(srv.url(), "sl_abc");
  CHECK(k.check == sl::win::KeyCheck::Ok);
  const auto reqs = srv.requests();
  CHECK_EQ(reqs.size(), size_t(1));
  if (!reqs.empty()) {
    CHECK_EQ(reqs[0].method, std::string("POST"));
    CHECK_EQ(reqs[0].path, std::string("/api/integrations/comms"));
    CHECK_EQ(reqs[0].authorization, std::string("sl_abc"));
    CHECK(reqs[0].body.empty());
  }
}

TEST(upload_sent_on_200_and_marks_sent) {
  testnet::Winsock ws;
  FakeServer srv({kKeyOk, {200, "{\"status\":\"waiting\",\"session_id\":1}"}});
  const fs::path dir = make_session("up200");
  const sl::win::UploadResult u = sl::win::upload_session(dir, srv.url(), "sl_abc", 1000);
  CHECK(u.outcome == sl::win::Outcome::Sent);
  CHECK_EQ(u.status, 200);
  CHECK(fs::exists(dir / "sent.json") && !fs::exists(dir / "failed.json"));
  const auto reqs = srv.requests();
  CHECK_EQ(reqs.size(), size_t(2));
  if (reqs.size() == 2) {
    CHECK(reqs[1].body.find("OggS") != std::string::npos);
    CHECK(reqs[1].body.find("name=\"files\"") != std::string::npos);
  }
}

TEST(upload_rejected_on_413_marks_failed) {
  testnet::Winsock ws;
  FakeServer srv({kKeyOk, {413, "{\"detail\":\"trop gros\"}"}});
  const fs::path dir = make_session("up413");
  const sl::win::UploadResult u = sl::win::upload_session(dir, srv.url(), "sl_abc", 1000);
  CHECK(u.outcome == sl::win::Outcome::Rejected);
  CHECK_EQ(u.message, std::string("trop gros"));
  CHECK(fs::exists(dir / "failed.json") && !fs::exists(dir / "sent.json"));
}

TEST(upload_settings_on_401_and_retry_on_503_leave_no_marker) {
  testnet::Winsock ws;
  {
    FakeServer srv({{401, "{\"detail\":\"cle\"}"}});
    const fs::path dir = make_session("up401");
    CHECK(sl::win::upload_session(dir, srv.url(), "sl_abc", 1000).outcome == sl::win::Outcome::Settings);
    CHECK(!fs::exists(dir / "sent.json") && !fs::exists(dir / "failed.json"));
  }
  {
    FakeServer srv({kKeyOk, {503, "indisponible"}});
    const fs::path dir = make_session("up503");
    const sl::win::UploadResult u = sl::win::upload_session(dir, srv.url(), "sl_abc", 1000);
    CHECK(u.outcome == sl::win::Outcome::Retry);
    CHECK_EQ(u.status, 503);
    CHECK(!fs::exists(dir / "sent.json") && !fs::exists(dir / "failed.json"));
  }
}

TEST(upload_rejects_missing_track_but_not_as_too_big) {
  testnet::Winsock ws;
  FakeServer srv({kKeyOk, {200, "{}"}});
  const fs::path dir = make_session("upmissing");
  fs::remove(dir / "t1.ogg");  // piste absente : refus définitif de la session (pas « trop lourde »)
  const sl::win::UploadResult u = sl::win::upload_session(dir, srv.url(), "sl_abc", 1000);
  CHECK(u.outcome == sl::win::Outcome::Rejected);
  CHECK(u.message.find("trop lourde") == std::string::npos);
}

TEST(upload_cancel_aborts_pending_request) {
  testnet::Winsock ws;
  for (int silent_from = 0; silent_from < 2; ++silent_from) {
    // 0 : le contrôle de la clé ne répond jamais ; 1 : c'est l'envoi du multipart
    FakeServer srv(silent_from == 0 ? std::vector<FakeResponse>{{0, ""}} : std::vector<FakeResponse>{kKeyOk, {0, ""}});
    const fs::path dir = make_session("upcancel");
    std::atomic<bool> cancel{false};
    std::thread t([&] {
      std::this_thread::sleep_for(std::chrono::milliseconds(300));
      cancel = true;
    });
    const auto t0 = std::chrono::steady_clock::now();
    const sl::win::UploadResult u = sl::win::upload_session(dir, srv.url(), "sl_abc", 1000, &cancel);
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    t.join();
    CHECK(u.outcome == sl::win::Outcome::Retry);
    CHECK(ms < 2000);
    CHECK(!fs::exists(dir / "sent.json") && !fs::exists(dir / "failed.json"));
  }
  std::atomic<bool> already{true};  // déjà annulé : aucune connexion
  FakeServer srv({kKeyOk});
  CHECK(sl::win::upload_session(make_session("upcancel2"), srv.url(), "sl_abc", 1000, &already).outcome ==
        sl::win::Outcome::Retry);
  CHECK(srv.requests().empty());
}

TEST(upload_with_invalid_site_is_a_settings_problem) {
  const fs::path dir = make_session("upsite");
  const sl::win::UploadResult u = sl::win::upload_session(dir, "https://u:p@host", "sl_abc", 1000);
  CHECK(u.outcome == sl::win::Outcome::Settings);
  CHECK(!fs::exists(dir / "sent.json") && !fs::exists(dir / "failed.json"));
}
