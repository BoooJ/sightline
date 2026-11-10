#include "core/timeutil.h"

#include <cctype>
#include <cstdio>

namespace sl {
namespace {
struct Civil {
  long long y;
  unsigned m, d;
};

// Algorithmes de H. Hinnant : jours depuis 1970 ↔ date du calendrier grégorien
Civil civil_from_days(long long z) {
  z += 719468;
  const long long era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned d = doy - (153 * mp + 2) / 5 + 1;
  const unsigned m = mp < 10 ? mp + 3 : mp - 9;
  return {static_cast<long long>(yoe) + era * 400 + (m <= 2 ? 1 : 0), m, d};
}

long long days_from_civil(long long y, unsigned m, unsigned d) {
  y -= m <= 2 ? 1 : 0;
  const long long era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<long long>(doe) - 719468;
}

struct Parts {
  Civil day;
  int hh, mi, ss, ms;
};

Parts split(int64_t unix_us) {
  long long ms = unix_us / 1000;
  if (unix_us % 1000 < 0) --ms;  // arrondi vers le bas avant 1970
  long long days = ms / 86400000;
  long long rest = ms % 86400000;
  if (rest < 0) {
    rest += 86400000;
    --days;
  }
  return {civil_from_days(days), static_cast<int>(rest / 3600000), static_cast<int>(rest / 60000 % 60),
          static_cast<int>(rest / 1000 % 60), static_cast<int>(rest % 1000)};
}
}  // namespace

std::string iso_utc_ms(int64_t unix_us) {
  const Parts p = split(unix_us);
  char buf[40];
  std::snprintf(buf, sizeof buf, "%04lld-%02u-%02uT%02d:%02d:%02d.%03dZ", p.day.y, p.day.m, p.day.d, p.hh, p.mi,
                p.ss, p.ms);
  return buf;
}

std::string folder_stamp(int64_t unix_us) {
  const Parts p = split(unix_us);
  char buf[40];
  std::snprintf(buf, sizeof buf, "%04lld%02u%02u-%02d%02d%02d", p.day.y, p.day.m, p.day.d, p.hh, p.mi, p.ss);
  return buf;
}

std::optional<int64_t> parse_folder_stamp(const std::string& name) {
  if (name.size() < 15 || name[8] != '-') return std::nullopt;
  for (int i = 0; i < 15; ++i)
    if (i != 8 && !std::isdigit(static_cast<unsigned char>(name[i]))) return std::nullopt;
  auto num = [&](int pos, int len) { return std::stoi(name.substr(pos, len)); };
  const int y = num(0, 4), m = num(4, 2), d = num(6, 2), hh = num(9, 2), mi = num(11, 2), ss = num(13, 2);
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return std::nullopt;
  const long long days = days_from_civil(y, static_cast<unsigned>(m), static_cast<unsigned>(d));
  return (days * 86400 + hh * 3600 + mi * 60 + ss) * kUsPerSecond;
}
}  // namespace sl
