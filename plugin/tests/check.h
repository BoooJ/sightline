// Mini cadre de test : TEST(nom) { CHECK(cond); CHECK_EQ(a, b); } ; main() dans check_main.cpp.
#pragma once
#include <cstdio>
#include <filesystem>
#include <functional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace check {
struct Case {
  const char* name;
  std::function<void()> fn;
};
inline std::vector<Case>& cases() {
  static std::vector<Case> v;
  return v;
}
inline int& failures() {
  static int n = 0;
  return n;
}
struct Reg {
  Reg(const char* n, std::function<void()> f) { cases().push_back({n, std::move(f)}); }
};
inline void fail(const char* file, int line, const std::string& what) {
  ++failures();
  std::printf("  ECHEC %s:%d : %s\n", file, line, what.c_str());
}
template <class A, class B>
void eq(const A& a, const B& b, const char* ea, const char* eb, const char* file, int line) {
  if (!(a == b)) {
    std::ostringstream s;
    s << ea << " == " << eb << "  (" << a << " / " << b << ")";
    fail(file, line, s.str());
  }
}
// Dossier vide et propre à un test, sous %TEMP%
inline std::filesystem::path temp_dir(const std::string& name) {
  const auto d = std::filesystem::temp_directory_path() / ("sightline-test-" + name);
  std::error_code ec;
  std::filesystem::remove_all(d, ec);
  std::filesystem::create_directories(d);
  return d;
}
}  // namespace check

#define CHECK_CAT2(a, b) a##b
#define CHECK_CAT(a, b) CHECK_CAT2(a, b)
#define TEST(name)                                          \
  static void name();                                       \
  static check::Reg CHECK_CAT(reg_, name)(#name, name);     \
  static void name()
#define CHECK(c)                                   \
  do {                                             \
    if (!(c)) check::fail(__FILE__, __LINE__, #c); \
  } while (0)
#define CHECK_EQ(a, b) check::eq((a), (b), #a, #b, __FILE__, __LINE__)
