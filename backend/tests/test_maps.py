from app.core.config import ROOT
from app.maps.registry import level_for_z, load_maps, resolve_site, world_to_radar

MAPS = load_maps(ROOT / "maps")


def test_all_pool_maps_loaded():
    assert {"de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke",
            "de_overpass", "de_train", "de_vertigo"} <= set(MAPS)


def test_world_to_radar_nuke():
    m = MAPS["de_nuke"]
    assert world_to_radar(m, -3453, 2887) == (0.0, 0.0)
    px, py = world_to_radar(m, -3453 + 700, 2887 - 1400)
    assert (px, py) == (100.0, 200.0)


def test_levels():
    m = MAPS["de_nuke"]
    assert level_for_z(m, 0) == "upper"
    assert level_for_z(m, -600) == "lower"
    assert level_for_z(MAPS["de_dust2"], -50) == MAPS["de_dust2"].levels[0].name


def test_resolve_site():
    m = MAPS["de_mirage"]
    ax = m.pos_x + m.bomb_a[0] * 1024 * m.scale
    ay = m.pos_y - m.bomb_a[1] * 1024 * m.scale
    assert resolve_site(m, ax, ay) == "A"
