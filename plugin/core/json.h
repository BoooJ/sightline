// JSON minimal : lire les messages GSI de CS2 et nos petits fichiers ; écrire des textes échappés.
#pragma once
#include <string>
#include <utility>
#include <vector>

namespace sl::json {
struct Value {
  enum class Type { Null, Bool, Number, String, Array, Object };
  Type type = Type::Null;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<Value> arr;
  std::vector<std::pair<std::string, Value>> obj;  // ordre du texte conservé

  bool is_object() const { return type == Type::Object; }
  bool is_array() const { return type == Type::Array; }
  bool is_string() const { return type == Type::String; }
  bool is_number() const { return type == Type::Number; }
  const Value* get(const std::string& key) const;  // nullptr si absent (ou pas un objet)
  std::string string_or(const std::string& key, const std::string& def = "") const;
  double number_or(const std::string& key, double def) const;
};
// false (et `error` rempli) si le texte n'est pas un JSON complet
bool parse(const std::string& text, Value& out, std::string* error = nullptr);
// "texte" entre guillemets, avec les échappements JSON (UTF-8 conservé tel quel)
std::string quote(const std::string& s);
}  // namespace sl::json
