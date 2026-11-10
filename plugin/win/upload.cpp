#include "win/upload.h"

#include "core/json.h"
#include "core/multipart.h"
#include "core/outbox.h"
#include "core/settings.h"
#include "win/http.h"

namespace sl::win {
std::string server_detail(const std::string& body) {
  json::Value v;
  if (json::parse(body, v) && v.is_object()) {
    const std::string d = v.string_or("detail");
    if (!d.empty()) return d;
  }
  return body.substr(0, 200);
}

KeyResult check_key(const std::string& site, const std::string& key, const std::atomic<bool>* cancel) {
  KeyResult k;
  const std::string base = clean_site(site);
  if (base.empty()) {
    k.check = KeyCheck::Refused;
    k.message = "adresse de Sightline invalide (https://…)";
    return k;
  }
  if (key.rfind("sl_", 0) != 0) {
    k.check = KeyCheck::Refused;
    k.message = "clé d'API manquante ou invalide (elle commence par sl_)";
    return k;
  }
  const HttpResult r = post(base + "/api/integrations/comms", key, "application/x-www-form-urlencoded", {}, 30, cancel);
  if (r.status == 400) {
    k.check = KeyCheck::Ok;
    k.message = "clé acceptée par Sightline";
  } else if (r.status == 401) {
    k.check = KeyCheck::Refused;
    k.message = "clé inconnue ou révoquée";
  } else if (r.status == 403) {
    k.check = KeyCheck::Refused;
    k.message = "cette clé n'a pas la portée « comms »";
  } else if (r.status == 404 || r.status == 405) {
    k.check = KeyCheck::Refused;
    k.message = "pas de Sightline à cette adresse";
  } else {
    k.check = KeyCheck::Unreachable;
    k.message = r.status ? "réponse inattendue de Sightline (" + std::to_string(r.status) + ")" : r.error;
  }
  return k;
}

UploadResult upload_session(const std::filesystem::path& dir, const std::string& site, const std::string& key,
                            int64_t now_us, const std::atomic<bool>* cancel) {
  UploadResult u;
  const std::string base = clean_site(site);
  if (base.empty()) {
    u.outcome = Outcome::Settings;
    u.message = "adresse du site invalide";
    return u;
  }
  const KeyResult k = check_key(site, key, cancel);
  if (k.check != KeyCheck::Ok) {
    u.outcome = k.check == KeyCheck::Refused ? Outcome::Settings : Outcome::Retry;
    u.message = k.message;
    return u;
  }
  Multipart mp;
  std::string error;
  if (!build_session_upload(dir, "sightline-" + random_hex(16), mp, error)) {
    u.message = error;
    if (!outbox::mark_failed(dir, now_us, error)) u.message += " ; marqueur failed.json non écrit";
    u.outcome = Outcome::Rejected;
    return u;
  }
  const uint64_t total = mp.total_size();
  if (total == UINT64_MAX) {  // une piste ne peut pas être lue : rien de définitif, nouvel essai plus tard
    u.outcome = Outcome::Retry;
    u.message = "fichier de piste illisible";
    return u;
  }
  if (total > kMaxUploadBytes) {
    u.message = "session trop lourde (200 Mo au plus)";
    if (!outbox::mark_failed(dir, now_us, u.message)) u.message += " ; marqueur failed.json non écrit";
    u.outcome = Outcome::Rejected;
    return u;
  }
  const HttpResult r = post_multipart(base + "/api/integrations/comms", key, mp, 120, cancel);
  u.status = r.status;
  if (r.status == 0 && cancel && cancel->load()) {
    u.outcome = Outcome::Retry;
    u.message = "envoi annulé";
    return u;
  }
  if (r.status >= 200 && r.status < 300) {
    const bool marked = outbox::mark_sent(dir, now_us, r.body);
    json::Value v;
    const bool attached = json::parse(r.body, v) && v.string_or("status") == "attached";
    u.outcome = Outcome::Sent;
    u.message = attached ? "comms envoyées et calées sur le match" : "comms envoyées, en attente de la démo du match";
    if (!marked) u.message += " (marqueur sent.json non écrit : la session pourra être renvoyée)";
  } else if (r.status == 400 || r.status == 413 || r.status == 422) {
    u.message = server_detail(r.body);
    if (!outbox::mark_failed(dir, now_us, u.message)) u.message += " ; marqueur failed.json non écrit";
    u.outcome = Outcome::Rejected;
  } else if (r.status == 401 || r.status == 403) {
    u.outcome = Outcome::Settings;
    u.message = server_detail(r.body);
  } else {
    u.outcome = Outcome::Retry;
    u.message = r.status ? "Sightline a répondu " + std::to_string(r.status) : r.error;
  }
  return u;
}
}  // namespace sl::win
