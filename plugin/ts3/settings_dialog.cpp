#include "ts3/settings_dialog.h"

#include <cctype>

#include "ts3/resource.h"
#include "win/text.h"

namespace sl {
namespace {
std::string get_text(HWND dlg, int id) {
  HWND h = GetDlgItem(dlg, id);
  const int n = GetWindowTextLengthW(h);
  std::wstring w(static_cast<size_t>(n) + 1, L'\0');
  GetWindowTextW(h, w.data(), n + 1);
  w.resize(static_cast<size_t>(n));
  return win::narrow(w);
}

void set_text(HWND dlg, int id, const std::string& s) { SetDlgItemTextW(dlg, id, win::widen(s).c_str()); }

// Espaces, tabulations, CR, LF aux deux bouts (une clé copiée d'une page web finit souvent par un saut de ligne)
std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

INT_PTR CALLBACK proc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
  const DialogApi* api = reinterpret_cast<const DialogApi*>(GetWindowLongPtrW(dlg, DWLP_USER));
  switch (msg) {
    case WM_INITDIALOG: {
      api = reinterpret_cast<const DialogApi*>(lp);
      SetWindowLongPtrW(dlg, DWLP_USER, static_cast<LONG_PTR>(lp));
      const Settings s = api->load();
      set_text(dlg, IDC_SITE, s.site);
      set_text(dlg, IDC_KEYSTATE, api->has_key()
                                      ? "Une clé est enregistrée : laisser vide pour la garder."
                                      : "Aucune clé : collez celle créée dans Sightline (portée « comms »).");
      std::string cfg = s.cs2_cfg_dir;
      if (cfg.empty()) {
        const std::vector<std::filesystem::path> found = api->detect_cfg_dirs();
        if (!found.empty()) cfg = found.front().u8string();
      }
      set_text(dlg, IDC_CFG, cfg);
      if (cfg.empty())
        set_text(dlg, IDC_STATUS, "Dossier de CS2 introuvable : indiquez …\\Counter-Strike Global Offensive\\game\\csgo\\cfg");
      if (api->opened) api->opened(dlg);
      return TRUE;
    }
    case WM_COMMAND:
      if (!api) break;
      switch (LOWORD(wp)) {
        case IDC_TEST:
          set_text(dlg, IDC_STATUS, "Test en cours…");
          UpdateWindow(GetDlgItem(dlg, IDC_STATUS));
          set_text(dlg, IDC_STATUS, api->test(trim(get_text(dlg, IDC_SITE)), trim(get_text(dlg, IDC_KEY))));
          return TRUE;
        case IDOK: {
          Settings s = api->load();
          const std::string site = clean_site(trim(get_text(dlg, IDC_SITE)));
          const std::string key = trim(get_text(dlg, IDC_KEY));
          if (site.empty()) {
            set_text(dlg, IDC_STATUS, "Adresse invalide : elle commence par https:// (ou http://).");
            return TRUE;
          }
          if (!key.empty() && key.rfind("sl_", 0) != 0) {
            set_text(dlg, IDC_STATUS, "La clé d'API commence par sl_.");
            return TRUE;
          }
          s.site = site;
          s.cs2_cfg_dir = trim(get_text(dlg, IDC_CFG));
          const std::string err = api->save(s, key);
          if (!err.empty()) {
            set_text(dlg, IDC_STATUS, err);
            return TRUE;
          }
          EndDialog(dlg, IDOK);
          return TRUE;
        }
        case IDCANCEL:
          EndDialog(dlg, IDCANCEL);
          return TRUE;
      }
      break;
    case WM_DESTROY:
      if (api && api->opened) api->opened(nullptr);
      break;
  }
  return FALSE;
}
}  // namespace

INT_PTR show_settings_dialog(HINSTANCE module, HWND parent, const DialogApi& api) {
  return DialogBoxParamW(module, MAKEINTRESOURCEW(IDD_SETTINGS), parent, proc, reinterpret_cast<LPARAM>(&api));
}
}  // namespace sl
