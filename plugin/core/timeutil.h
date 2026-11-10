// Heure murale UTC en microsecondes depuis 1970 (horloge du PC) ↔ textes ISO 8601 et noms de dossiers.
#pragma once
#include <cstdint>
#include <optional>
#include <string>

namespace sl {
constexpr int64_t kUsPerSecond = 1000000;
// "2026-10-24T19:30:01.123Z" : millisecondes, UTC, « Z » (format attendu par Sightline)
std::string iso_utc_ms(int64_t unix_us);
// "20261024-193001" : nom du dossier d'une session (ordre alphabétique = ordre chronologique)
std::string folder_stamp(int64_t unix_us);
// Inverse de folder_stamp, à la seconde ; accepte un suffixe ("-2") ; nullopt si ce n'est pas un tel nom
std::optional<int64_t> parse_folder_stamp(const std::string& name);
}  // namespace sl
