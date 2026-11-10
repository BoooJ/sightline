# backend/tests/test_cache_disk.py
"""Cache des calculs coûteux : en mémoire et sur disque (survit à un redémarrage)."""
from app.stats import cache as c


def test_disk_cache_survives_restart(tmp_path):
    c.enable_disk(tmp_path)
    try:
        calls = []
        a = c.LibraryCache(4, name="t")
        assert a.get_fixed(("m", 1), lambda: calls.append(1) or {"x": 1}) == {"x": 1}
        assert a.get_fixed(("m", 1), lambda: calls.append(2) or {"x": 2}) == {"x": 1}
        # « redémarrage » : nouveau cache vide en mémoire, même fichier sur disque
        b = c.LibraryCache(4, name="t")
        assert b.get_fixed(("m", 1), lambda: calls.append(3) or {"x": 3}) == {"x": 1}
        assert calls == [1]
        # un match ré-analysé est oublié sur disque aussi
        b.drop(lambda k: k[1] == 1)
        assert c.LibraryCache(4, name="t").get_fixed(("m", 1), lambda: {"x": 4}) == {"x": 4}
        # la génération (ré-analyses, équipes modifiées) est conservée elle aussi
        before = c.LibraryCache.generation
        c.LibraryCache.bump()
        c.LibraryCache.generation = 0
        c.enable_disk(tmp_path)
        assert c.LibraryCache.generation == before + 1
    finally:
        c.disable_disk()
