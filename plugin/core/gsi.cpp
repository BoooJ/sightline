#include "core/gsi.h"

#include "core/json.h"

namespace sl {
bool parse_gsi(const std::string& body, GsiState& out) {
  json::Value v;
  if (!json::parse(body, v) || !v.is_object()) return false;
  out = GsiState{};
  if (const json::Value* a = v.get("auth")) out.token = a->string_or("token");
  if (const json::Value* p = v.get("provider")) out.steamid = p->string_or("steamid");
  if (const json::Value* m = v.get("map"); m && m->is_object()) {
    out.has_map = true;
    out.map = m->string_or("name");
    out.map_phase = m->string_or("phase");
    out.map_round = static_cast<int>(m->number_or("round", -1));
    if (const json::Value* ct = m->get("team_ct")) out.score_ct = static_cast<int>(ct->number_or("score", -1));
    if (const json::Value* t = m->get("team_t")) out.score_t = static_cast<int>(t->number_or("score", -1));
  }
  if (const json::Value* r = v.get("round")) out.round_phase = r->string_or("phase");
  return true;
}

std::string clean_map(const std::string& name) {
  const size_t slash = name.find_last_of("/\\");
  const std::string base = slash == std::string::npos ? name : name.substr(slash + 1);
  std::string out;
  for (const unsigned char c : base) {
    if (c >= 'A' && c <= 'Z') out += static_cast<char>(c - 'A' + 'a');
    else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') out += static_cast<char>(c);
    else out += '_';
  }
  if (out.size() > 64) out.resize(64);
  return out.size() >= 2 ? out : "inconnue";
}
}  // namespace sl
