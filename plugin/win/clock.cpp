#include "win/clock.h"

#include <windows.h>

namespace sl::win {
int64_t now_us() {
  FILETIME ft;
  GetSystemTimePreciseAsFileTime(&ft);
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return static_cast<int64_t>((u.QuadPart - 116444736000000000ULL) / 10);  // 100 ns depuis 1601 → µs depuis 1970
}
}  // namespace sl::win
