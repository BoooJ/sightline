#include "check.h"
#include "core/json.h"

TEST(json_parses_objects_arrays_and_escapes) {
  sl::json::Value v;
  std::string err;
  // (texte hors de CHECK : MSVC transforme mal une chaîne brute passée à # dans une macro)
  const std::string text = R"( {"a": 1.5, "b": [true, false, null], "c": "x\"yé😀", "d": {"e": -2}} )";
  CHECK(sl::json::parse(text, v, &err));
  CHECK(v.is_object());
  CHECK_EQ(v.number_or("a", 0), 1.5);
  const sl::json::Value* b = v.get("b");
  CHECK(b && b->is_array() && b->arr.size() == 3);
  CHECK(b && b->arr[0].type == sl::json::Value::Type::Bool && b->arr[0].b);
  CHECK(b && b->arr[2].type == sl::json::Value::Type::Null);
  CHECK_EQ(v.string_or("c"), std::string("x\"y\xC3\xA9\xF0\x9F\x98\x80"));
  CHECK_EQ(v.get("d")->number_or("e", 0), -2.0);
  CHECK_EQ(v.string_or("absent", "défaut"), std::string("défaut"));
  CHECK_EQ(v.number_or("c", 7), 7.0);  // pas un nombre : défaut
}

TEST(json_rejects_bad_input) {
  sl::json::Value v;
  CHECK(!sl::json::parse("{\"a\":}", v));
  CHECK(!sl::json::parse("[1, 2", v));
  CHECK(!sl::json::parse("{\"a\": 1} x", v));
  CHECK(!sl::json::parse("", v));
  CHECK(!sl::json::parse(std::string(100, '[') + std::string(100, ']'), v));  // trop imbriqué
}

TEST(json_quote_escapes) {
  CHECK_EQ(sl::json::quote("a\"b\\c\n\x01é"), std::string("\"a\\\"b\\\\c\\n\\u0001é\""));
}
