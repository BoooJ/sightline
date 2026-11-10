#include "check.h"
#include "core/timeutil.h"

TEST(iso_utc_ms_formats_utc_with_milliseconds) {
  CHECK_EQ(sl::iso_utc_ms(1792870201123000), std::string("2026-10-24T19:30:01.123Z"));
  CHECK_EQ(sl::iso_utc_ms(1792870201123999), std::string("2026-10-24T19:30:01.123Z"));  // tronqué, pas arrondi
  CHECK_EQ(sl::iso_utc_ms(951868799999000), std::string("2000-02-29T23:59:59.999Z"));
  CHECK_EQ(sl::iso_utc_ms(0), std::string("1970-01-01T00:00:00.000Z"));
  CHECK_EQ(sl::iso_utc_ms(-1), std::string("1969-12-31T23:59:59.999Z"));
}

TEST(folder_stamp_round_trip) {
  CHECK_EQ(sl::folder_stamp(1792870201123000), std::string("20261024-193001"));
  CHECK(sl::parse_folder_stamp("20261024-193001") == std::optional<int64_t>(1792870201000000));
  CHECK(sl::parse_folder_stamp("20261024-193001-2") == std::optional<int64_t>(1792870201000000));
  CHECK(!sl::parse_folder_stamp("session"));
  CHECK(!sl::parse_folder_stamp("20261324-193001"));
}
