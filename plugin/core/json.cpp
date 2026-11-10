#include "core/json.h"

#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace sl::json {
namespace {
void put_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out += static_cast<char>(cp);
  } else if (cp < 0x800) {
    out += static_cast<char>(0xC0 | (cp >> 6));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    out += static_cast<char>(0xE0 | (cp >> 12));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (cp >> 18));
    out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  }
}

struct Parser {
  const std::string& s;
  size_t i = 0;
  int depth = 0;
  std::string err;

  bool fail(const char* what) {
    if (err.empty()) err = std::string(what) + " (position " + std::to_string(i) + ")";
    return false;
  }
  void ws() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
  }
  bool word(const char* w, Value& v, Value::Type t, bool b) {
    const size_t n = std::strlen(w);
    if (s.compare(i, n, w) != 0) return fail("valeur inconnue");
    i += n;
    v.type = t;
    v.b = b;
    return true;
  }
  bool hex4(uint32_t& out) {
    if (i + 4 > s.size()) return fail("\\u incomplet");
    out = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = s[i++];
      out <<= 4;
      if (c >= '0' && c <= '9') out |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') out |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') out |= static_cast<uint32_t>(c - 'A' + 10);
      else return fail("\\u invalide");
    }
    return true;
  }
  bool text(std::string& out) {
    ++i;  // guillemet ouvrant
    while (i < s.size()) {
      const char c = s[i++];
      if (c == '"') return true;
      if (c != '\\') {
        out += c;
        continue;
      }
      if (i >= s.size()) break;
      const char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t cp = 0;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
            i += 2;
            uint32_t lo = 0;
            if (!hex4(lo)) return false;
            if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          put_utf8(out, cp);
          break;
        }
        default: return fail("échappement invalide");
      }
    }
    return fail("texte non terminé");
  }
  bool number(Value& v) {
    const size_t start = i;
    while (i < s.size() && s[i] != '\0' && std::strchr("+-0123456789.eE", s[i]) != nullptr) ++i;
    if (start == i) return fail("valeur attendue");
    const char* b = s.data() + start;
    const char* e = s.data() + i;
    const auto res = std::from_chars(b, e, v.num);  // indépendant de la locale (Qt peut la changer)
    if (res.ec != std::errc() || res.ptr != e) return fail("nombre invalide");
    v.type = Value::Type::Number;
    return true;
  }
  bool value(Value& v) {
    if (++depth > 64) return fail("JSON trop imbriqué");
    ws();
    bool ok = false;
    if (i >= s.size()) ok = fail("fin inattendue");
    else if (s[i] == '{') ok = object(v);
    else if (s[i] == '[') ok = array(v);
    else if (s[i] == '"') {
      v.type = Value::Type::String;
      ok = text(v.str);
    } else if (s[i] == 't') ok = word("true", v, Value::Type::Bool, true);
    else if (s[i] == 'f') ok = word("false", v, Value::Type::Bool, false);
    else if (s[i] == 'n') ok = word("null", v, Value::Type::Null, false);
    else ok = number(v);
    --depth;
    return ok;
  }
  bool object(Value& v) {
    v.type = Value::Type::Object;
    ++i;
    ws();
    if (i < s.size() && s[i] == '}') {
      ++i;
      return true;
    }
    for (;;) {
      ws();
      if (i >= s.size() || s[i] != '"') return fail("clé attendue");
      std::string key;
      if (!text(key)) return false;
      ws();
      if (i >= s.size() || s[i] != ':') return fail("« : » attendu");
      ++i;
      Value item;
      if (!value(item)) return false;
      v.obj.emplace_back(std::move(key), std::move(item));
      ws();
      if (i < s.size() && s[i] == ',') {
        ++i;
        continue;
      }
      if (i < s.size() && s[i] == '}') {
        ++i;
        return true;
      }
      return fail("« , » ou « } » attendu");
    }
  }
  bool array(Value& v) {
    v.type = Value::Type::Array;
    ++i;
    ws();
    if (i < s.size() && s[i] == ']') {
      ++i;
      return true;
    }
    for (;;) {
      Value item;
      if (!value(item)) return false;
      v.arr.push_back(std::move(item));
      ws();
      if (i < s.size() && s[i] == ',') {
        ++i;
        continue;
      }
      if (i < s.size() && s[i] == ']') {
        ++i;
        return true;
      }
      return fail("« , » ou « ] » attendu");
    }
  }
};
}  // namespace

const Value* Value::get(const std::string& key) const {
  if (type != Type::Object) return nullptr;
  for (const auto& kv : obj)
    if (kv.first == key) return &kv.second;
  return nullptr;
}

std::string Value::string_or(const std::string& key, const std::string& def) const {
  const Value* v = get(key);
  return v && v->is_string() ? v->str : def;
}

double Value::number_or(const std::string& key, double def) const {
  const Value* v = get(key);
  return v && v->is_number() ? v->num : def;
}

bool parse(const std::string& text, Value& out, std::string* error) {
  Parser p{text};
  Value v;
  bool ok = p.value(v);
  if (ok) {
    p.ws();
    if (p.i != text.size()) ok = p.fail("texte après le JSON");
  }
  if (!ok) {
    if (error) *error = p.err;
    return false;
  }
  out = std::move(v);
  return true;
}

std::string quote(const std::string& s) {
  std::string o = "\"";
  for (const unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          std::snprintf(b, sizeof b, "\\u%04x", c);
          o += b;
        } else {
          o += static_cast<char>(c);
        }
    }
  }
  return o + "\"";
}
}  // namespace sl::json
