// Dossiers cfg de CS2 qui existent, trouvés via Steam (registre → libraryfolders.vdf) ; ceux des bibliothèques
// qui annoncent l'application 730 d'abord (la liste « apps » peut être périmée : on teste aussi les autres).
#pragma once
#include <filesystem>
#include <vector>

namespace sl::win {
std::vector<std::filesystem::path> find_cs2_cfg_dirs();
}  // namespace sl::win
