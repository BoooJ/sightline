#include "core/outbox.h"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <iterator>

#include "core/json.h"
#include "core/timeutil.h"

namespace fs = std::filesystem;

namespace sl::outbox {
namespace {
bool present(const fs::path& p) {  // (pas « exists » : ambigu avec std::filesystem::exists par ADL)
  std::error_code ec;
  return fs::exists(p, ec);
}
// Écrit dans <nom>.part puis renomme : le fichier final est complet ou absent
bool write_text(const fs::path& p, const std::string& s) {
  fs::path part = p;
  part += ".part";
  {
    std::ofstream f(part, std::ios::binary | std::ios::trunc);
    f << s;
    f.close();
    if (f.fail()) {
      std::error_code ec;
      fs::remove(part, ec);
      return false;
    }
  }
  std::error_code ec;
  fs::rename(part, p, ec);
  if (ec) {
    fs::remove(part, ec);
    return false;
  }
  return true;
}
// Date de dernière écriture en microsecondes Unix ; -1 si illisible
int64_t mtime_us(const fs::path& p) {
  std::error_code ec;
  const auto ft = fs::last_write_time(p, ec);
  if (ec) return -1;
  const auto offset = std::chrono::system_clock::now().time_since_epoch() -
                      std::chrono::duration_cast<std::chrono::system_clock::duration>(
                          fs::file_time_type::clock::now().time_since_epoch());
  const auto unix_d = std::chrono::duration_cast<std::chrono::microseconds>(ft.time_since_epoch() + offset);
  return unix_d.count();
}
std::string read_text(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}
}  // namespace

std::vector<Entry> scan(const fs::path& root) {
  std::vector<Entry> out;
  std::error_code ec;
  for (fs::directory_iterator it(root, ec), end; !ec && it != end; it.increment(ec)) {
    if (!it->is_directory(ec)) continue;
    const fs::path& p = it->path();
    State st = State::Incomplete;
    if (present(p / "session.json"))
      st = present(p / "sent.json") ? State::Sent : present(p / "failed.json") ? State::Failed : State::Pending;
    out.push_back({p, st});
  }
  std::sort(out.begin(), out.end(), [](const Entry& a, const Entry& b) { return a.dir.filename() < b.dir.filename(); });
  return out;
}

bool mark_sent(const fs::path& dir, int64_t now_us, const std::string& response) {
  if (!write_text(dir / "sent.json",
                  "{\"sent_at_us\":" + std::to_string(now_us) + ",\"response\":" + json::quote(response) + "}"))
    return false;
  std::error_code ec;
  fs::remove(dir / "failed.json", ec);
  return true;
}

bool mark_failed(const fs::path& dir, int64_t now_us, const std::string& reason) {
  return write_text(dir / "failed.json",
                    "{\"failed_at_us\":" + std::to_string(now_us) + ",\"reason\":" + json::quote(reason) + "}");
}

void reset(const fs::path& dir) {
  std::error_code ec;
  fs::remove(dir / "sent.json", ec);
  fs::remove(dir / "failed.json", ec);
}

std::optional<fs::path> latest(const fs::path& root) {
  const std::vector<Entry> all = scan(root);
  for (auto it = all.rbegin(); it != all.rend(); ++it)
    if (it->state != State::Incomplete) return it->dir;
  return std::nullopt;
}

int cleanup(const fs::path& root, int64_t now_us) {
  int removed = 0;
  for (const Entry& e : scan(root)) {
    int64_t since = -1;
    if (e.state == State::Sent) {
      json::Value v;
      if (json::parse(read_text(e.dir / "sent.json"), v) && v.is_object())
        since = static_cast<int64_t>(v.number_or("sent_at_us", -1));
      // sent.json tronqué ou sans date : date de dernière écriture, sinon date du dossier
      if (since < 0) since = mtime_us(e.dir / "sent.json");
      if (since < 0)
        if (const auto t = parse_folder_stamp(e.dir.filename().u8string())) since = *t;
    } else if (e.state == State::Incomplete) {
      if (const auto t = parse_folder_stamp(e.dir.filename().u8string())) since = *t;
    }
    if (since < 0 || now_us - since <= kKeepUs) continue;
    std::error_code ec;
    fs::remove_all(e.dir, ec);
    if (!ec) ++removed;
  }
  return removed;
}
}  // namespace sl::outbox
