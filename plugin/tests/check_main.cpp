#include <exception>

#include "check.h"

int main() {
  for (const check::Case& c : check::cases()) {
    const int before = check::failures();
    try {
      c.fn();
    } catch (const std::exception& e) {
      check::fail(c.name, 0, std::string("exception : ") + e.what());
    }
    std::printf("%s %s\n", check::failures() == before ? "ok  " : "FAIL", c.name);
  }
  std::printf("%zu tests, %d echec(s)\n", check::cases().size(), check::failures());
  return check::failures() ? 1 : 0;
}
