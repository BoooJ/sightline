#include "check.h"
#include "core/gsi.h"
#include "core/http_head.h"
#include "gsi_json.h"

TEST(gsi_reads_provider_map_round_and_token) {
  sl::GsiState s;
  CHECK(sl::parse_gsi(testgsi::map("jeton", "live", "freezetime", 3, 2, 1, "de_mirage"), s));
  CHECK_EQ(s.token, std::string("jeton"));
  CHECK_EQ(s.steamid, std::string("76561198000000001"));
  CHECK(s.has_map);
  CHECK_EQ(s.map, std::string("de_mirage"));
  CHECK_EQ(s.map_phase, std::string("live"));
  CHECK_EQ(s.map_round, 3);
  CHECK_EQ(s.score_ct, 2);
  CHECK_EQ(s.score_t, 1);
  CHECK_EQ(s.round_phase, std::string("freezetime"));
  sl::GsiState m;
  CHECK(sl::parse_gsi(testgsi::menu("jeton"), m));
  CHECK(!m.has_map);
  CHECK_EQ(m.round_phase, std::string(""));
  CHECK_EQ(m.map_round, -1);
  CHECK(!sl::parse_gsi("pas du json", s));
  CHECK(!sl::parse_gsi("[1]", s));
}

TEST(clean_map_keeps_sightline_names) {
  CHECK_EQ(sl::clean_map("de_mirage"), std::string("de_mirage"));
  CHECK_EQ(sl::clean_map("workshop/123456/de_cache"), std::string("de_cache"));
  CHECK_EQ(sl::clean_map("De-Dust2"), std::string("de_dust2"));
  CHECK_EQ(sl::clean_map(""), std::string("inconnue"));
  CHECK_EQ(sl::clean_map("x"), std::string("inconnue"));
  CHECK_EQ(sl::clean_map(std::string(70, 'a')).size(), size_t(64));
}

TEST(http_head_reads_method_and_length) {
  const sl::HttpHead h = sl::parse_http_head(
      "POST /gsi HTTP/1.1\r\nHost: 127.0.0.1:47811\r\ncontent-length: 42\r\nContent-Type: application/json");
  CHECK(h.ok);
  CHECK_EQ(h.method, std::string("POST"));
  CHECK_EQ(h.target, std::string("/gsi"));
  CHECK_EQ(h.content_length, size_t(42));
  const sl::HttpHead g = sl::parse_http_head("GET / HTTP/1.1");
  CHECK(g.ok && g.method == "GET" && g.content_length == 0);
  CHECK(!sl::parse_http_head("n'importe quoi").ok);
  CHECK(!sl::parse_http_head("POST /x HTTP/1.1\r\nContent-Length: abc").ok);
}

TEST(http_head_rejects_huge_content_length_even_on_32_bits) {
  CHECK(!sl::parse_http_head("POST /x HTTP/1.1\r\nContent-Length: 4294967296").ok);
  CHECK(!sl::parse_http_head("POST /x HTTP/1.1\r\nContent-Length: 99999999999999999999").ok);
  CHECK(!sl::parse_http_head("POST /x HTTP/1.1\r\nContent-Length: 1073741825").ok);
  CHECK(sl::parse_http_head("POST /x HTTP/1.1\r\nContent-Length: 65536").content_length == size_t(65536));
}
