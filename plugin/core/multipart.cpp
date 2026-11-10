#include "core/multipart.h"

#include <fstream>
#include <iterator>

#include "core/json.h"

namespace fs = std::filesystem;

namespace sl {
uint64_t segments_size(const std::vector<Segment>& segments) {
  uint64_t n = 0;
  for (const Segment& s : segments) {
    uint64_t add = s.bytes.size();
    if (!s.file.empty()) {
      std::error_code ec;
      const auto sz = fs::file_size(s.file, ec);
      if (ec) return UINT64_MAX;  // illisible : « trop gros », jamais une taille fausse
      add = static_cast<uint64_t>(sz);
    }
    if (add > UINT64_MAX - n) return UINT64_MAX;
    n += add;
  }
  return n;
}

bool build_session_upload(const fs::path& dir, const std::string& boundary, Multipart& out, std::string& error) {
  std::ifstream f(dir / "session.json", std::ios::binary);
  if (!f) {
    error = "session.json absent";
    return false;
  }
  const std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  json::Value v;
  if (!json::parse(text, v) || !v.is_object()) {
    error = "session.json illisible";
    return false;
  }
  const json::Value* tracks = v.get("tracks");
  if (!tracks || !tracks->is_array() || tracks->arr.empty()) {
    error = "session sans piste";
    return false;
  }
  out = Multipart{boundary, {}};
  const std::string dash = "--" + boundary + "\r\n";
  out.segments.push_back({dash + "Content-Disposition: form-data; name=\"session\"\r\n"
                                 "Content-Type: application/json\r\n\r\n" + text + "\r\n", {}});
  for (const json::Value& t : tracks->arr) {
    const std::string name = t.string_or("file");
    if (name.empty() || name.find_first_of("/\\\":") != std::string::npos || name.find("..") != std::string::npos) {
      error = "nom de piste invalide : " + name;
      return false;
    }
    const fs::path file = dir / fs::u8path(name);
    std::error_code ec;
    if (!fs::is_regular_file(file, ec)) {
      error = "piste absente : " + name;
      return false;
    }
    out.segments.push_back({dash + "Content-Disposition: form-data; name=\"files\"; filename=\"" + name +
                                "\"\r\nContent-Type: audio/ogg\r\n\r\n", {}});
    out.segments.push_back({{}, file});
    out.segments.push_back({"\r\n", {}});
  }
  out.segments.push_back({"--" + boundary + "--\r\n", {}});
  return true;
}
}  // namespace sl
