#include <filesystem>
#include <fstream>
#include <iterator>

#include "check.h"
#include "core/settings.h"
#include "core/steam.h"

namespace fs = std::filesystem;

TEST(settings_round_trip_and_defaults) {
  const fs::path dir = check::temp_dir("settings");
  const sl::Settings d = sl::load_settings(dir / "settings.json");
  CHECK_EQ(d.site, std::string("https://sightline.example.com"));
  CHECK_EQ(d.gsi_port, 47811);
  CHECK(d.gsi_token.empty());
  sl::Settings s;
  s.site = "http://127.0.0.1:8011";
  s.cs2_cfg_dir = "D:\\Jeux\\Counter-Strike Global Offensive\\game\\csgo\\cfg é";
  s.gsi_token = "abc123";
  s.gsi_port = 47812;
  CHECK(sl::save_settings(dir / "settings.json", s));
  const sl::Settings r = sl::load_settings(dir / "settings.json");
  CHECK_EQ(r.site, s.site);
  CHECK_EQ(r.cs2_cfg_dir, s.cs2_cfg_dir);
  CHECK_EQ(r.gsi_token, s.gsi_token);
  CHECK_EQ(r.gsi_port, 47812);
  std::ofstream(dir / "bad.json") << "{\"gsi_port\": 80}";
  CHECK_EQ(sl::load_settings(dir / "bad.json").gsi_port, 47811);
}

TEST(clean_site_and_random_hex) {
  CHECK_EQ(sl::clean_site("https://sightline.example.com/"), std::string("https://sightline.example.com"));
  CHECK_EQ(sl::clean_site(" http://127.0.0.1:8011 "), std::string("http://127.0.0.1:8011"));
  CHECK_EQ(sl::clean_site("sightline.example.com"), std::string(""));
  CHECK_EQ(sl::clean_site("https://"), std::string(""));
  for (const char* bad : {"http:///x", "https://:80", "https://u:p@host", "https://host?x=1", "https://host#f",
                          "https://host/api", "https://host/a/../b", "https://host:0", "https://host:65536",
                          "https://-host", "https://host", "https://host.", "https://host:", "https://host//"})
    CHECK_EQ(sl::clean_site(bad), std::string(""));
  CHECK_EQ(sl::clean_site("http://127.0.0.1:8123"), std::string("http://127.0.0.1:8123"));
  CHECK_EQ(sl::clean_site("HTTPS://Demos.example/"), std::string("HTTPS://Demos.example"));
  const std::string a = sl::random_hex(16), b = sl::random_hex(16);
  CHECK_EQ(a.size(), size_t(32));
  CHECK(a != b);
  CHECK(a.find_first_not_of("0123456789abcdef") == std::string::npos);
}

TEST(libraryfolders_lists_libraries_and_cs2) {
  const std::string vdf = R"vdf("libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"contentid"		"7667258588165295703"
		"apps"
		{
			"240"		"4890190519"
			"431960"		"618167723"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"apps"
		{
			"730"		"39876543210"
		}
	}
}
)vdf";
  const auto libs = sl::parse_libraryfolders(vdf);
  CHECK_EQ(libs.size(), size_t(2));
  if (libs.size() == 2) {
    CHECK_EQ(libs[0].path, std::string("C:\\Program Files (x86)\\Steam"));
    CHECK(!libs[0].has_cs2);
    CHECK_EQ(libs[1].path, std::string("D:\\SteamLibrary"));
    CHECK(libs[1].has_cs2);
  }
  const auto old = sl::parse_libraryfolders(
      "\"LibraryFolders\"\n{\n\t\"TimeNextStatsReport\"\t\"123\"\n\t\"ContentStatsID\"\t\"-1\"\n"
      "\t\"1\"\t\"E:\\\\Games\\\\Steam\"\n}\n");
  CHECK_EQ(old.size(), size_t(1));
  if (!old.empty()) CHECK_EQ(old[0].path, std::string("E:\\Games\\Steam"));
  CHECK(sl::parse_libraryfolders("n'importe quoi").empty());
  CHECK_EQ(sl::cs2_cfg_dir("D:\\SteamLibrary").u8string(),
           std::string("D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg"));
}

TEST(gsi_cfg_content_and_install) {
  CHECK_EQ(sl::gsi_cfg(47811, "abc"), std::string("\"Sightline Comms\"\n{\n"
                                                  " \"uri\" \"http://127.0.0.1:47811/gsi\"\n"
                                                  " \"timeout\" \"1.0\"\n"
                                                  " \"buffer\" \"0.0\"\n"
                                                  " \"throttle\" \"0.0\"\n"
                                                  " \"heartbeat\" \"10.0\"\n"
                                                  " \"auth\"\n {\n  \"token\" \"abc\"\n }\n"
                                                  " \"data\"\n {\n  \"provider\" \"1\"\n  \"map\" \"1\"\n"
                                                  "  \"round\" \"1\"\n }\n}\n"));
  const fs::path dir = check::temp_dir("cs2cfg");
  std::string err;
  CHECK_EQ(sl::install_gsi_cfg(dir, 47811, "abc", err), 1);
  std::ifstream f(dir / sl::kGsiFileName, std::ios::binary);
  CHECK_EQ(std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>()), sl::gsi_cfg(47811, "abc"));
  CHECK_EQ(sl::install_gsi_cfg(dir, 47811, "abc", err), 0);  // déjà à jour
  CHECK_EQ(sl::install_gsi_cfg(dir, 47811, "autre", err), 1);
  CHECK_EQ(sl::install_gsi_cfg(dir / "absent", 47811, "abc", err), -1);
  CHECK(!err.empty());
}
