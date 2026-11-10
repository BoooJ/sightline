#include "core/steam.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iterator>
#include <utility>

namespace fs = std::filesystem;

namespace sl {
namespace {
struct Tok {
  enum Kind { Str, Open, Close, End } kind;
  std::string s;
};

struct Lexer {
  const std::string& t;
  size_t i = 0;
  Tok next() {
    for (;;) {
      while (i < t.size() && std::isspace(static_cast<unsigned char>(t[i]))) ++i;
      if (i + 1 < t.size() && t[i] == '/' && t[i + 1] == '/') {
        while (i < t.size() && t[i] != '\n') ++i;
        continue;
      }
      break;
    }
    if (i >= t.size()) return {Tok::End, {}};
    if (t[i] == '{') {
      ++i;
      return {Tok::Open, {}};
    }
    if (t[i] == '}') {
      ++i;
      return {Tok::Close, {}};
    }
    std::string s;
    if (t[i] == '"') {
      ++i;
      while (i < t.size() && t[i] != '"') {
        if (t[i] == '\\' && i + 1 < t.size()) {
          const char e = t[i + 1];
          s += e == 'n' ? '\n' : e == 't' ? '\t' : e;
          i += 2;
          continue;
        }
        s += t[i++];
      }
      ++i;
    } else {
      while (i < t.size() && !std::isspace(static_cast<unsigned char>(t[i])) && t[i] != '{' && t[i] != '}' &&
             t[i] != '"')
        s += t[i++];
    }
    return {Tok::Str, s};
  }
};

struct Node {
  std::string value;
  bool is_obj = false;
  std::vector<std::pair<std::string, Node>> kids;
};

bool parse_obj(Lexer& lx, Node& out, int depth) {
  out.is_obj = true;
  for (;;) {
    const Tok k = lx.next();
    if (k.kind == Tok::Close) return true;
    if (k.kind != Tok::Str) return false;
    const Tok v = lx.next();
    Node child;
    if (v.kind == Tok::Str) {
      child.value = v.s;
    } else if (v.kind == Tok::Open) {
      const bool ok = depth < 16 && parse_obj(lx, child, depth + 1);
      out.kids.emplace_back(k.s, std::move(child));
      if (!ok) return false;
      continue;
    } else {
      return false;
    }
    out.kids.emplace_back(k.s, std::move(child));
  }
}

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

const Node* find(const Node& n, const std::string& key) {
  for (const auto& kv : n.kids)
    if (lower(kv.first) == key) return &kv.second;
  return nullptr;
}
}  // namespace

std::vector<SteamLibrary> parse_libraryfolders(const std::string& vdf) {
  Lexer lx{vdf};
  const Tok name = lx.next();
  if (name.kind != Tok::Str || lower(name.s) != "libraryfolders" || lx.next().kind != Tok::Open) return {};
  Node top;
  parse_obj(lx, top, 0);  // fichier tronqué : on garde ce qui a été lu
  std::vector<SteamLibrary> out;
  for (const auto& kv : top.kids) {
    SteamLibrary lib;
    if (kv.second.is_obj) {
      const Node* p = find(kv.second, "path");
      if (!p) continue;
      lib.path = p->value;
      if (const Node* apps = find(kv.second, "apps")) lib.has_cs2 = find(*apps, "730") != nullptr;
    } else {
      // ancien format : "1" "D:\\SteamLibrary" (les autres clés ne sont pas des bibliothèques)
      const bool numeric = !kv.first.empty() && std::all_of(kv.first.begin(), kv.first.end(), [](unsigned char c) {
        return std::isdigit(c) != 0;
      });
      if (!numeric) continue;
      lib.path = kv.second.value;
    }
    if (!lib.path.empty()) out.push_back(lib);
  }
  return out;
}

fs::path cs2_cfg_dir(const fs::path& library) {
  return library / "steamapps" / "common" / "Counter-Strike Global Offensive" / "game" / "csgo" / "cfg";
}

std::string gsi_cfg(int port, const std::string& token) {
  return "\"Sightline Comms\"\n{\n"
         " \"uri\" \"http://127.0.0.1:" + std::to_string(port) + "/gsi\"\n"
         " \"timeout\" \"1.0\"\n"
         " \"buffer\" \"0.0\"\n"
         " \"throttle\" \"0.0\"\n"
         " \"heartbeat\" \"10.0\"\n"
         " \"auth\"\n {\n  \"token\" \"" + token + "\"\n }\n"
         " \"data\"\n {\n  \"provider\" \"1\"\n  \"map\" \"1\"\n  \"round\" \"1\"\n }\n}\n";
}

int install_gsi_cfg(const fs::path& cfg_dir, int port, const std::string& token, std::string& error) {
  std::error_code ec;
  if (!fs::is_directory(cfg_dir, ec)) {
    error = "dossier introuvable : " + cfg_dir.u8string();
    return -1;
  }
  const fs::path file = cfg_dir / kGsiFileName;
  const std::string want = gsi_cfg(port, token);
  {
    std::ifstream in(file, std::ios::binary);
    if (in && std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()) == want) return 0;
  }
  std::ofstream out(file, std::ios::binary | std::ios::trunc);
  out << want;
  out.close();
  if (out.fail()) {
    error = "écriture impossible : " + file.u8string();
    return -1;
  }
  return 1;
}
}  // namespace sl
