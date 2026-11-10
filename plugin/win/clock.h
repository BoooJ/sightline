// Heure murale UTC précise (µs depuis 1970) : la même horloge pour la voix et pour la GSI.
#pragma once
#include <cstdint>

namespace sl::win {
int64_t now_us();
}  // namespace sl::win
