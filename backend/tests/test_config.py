# backend/tests/test_config.py
from pathlib import Path

from app.core.config import Settings, load_settings, save_settings


def test_defaults(tmp_path: Path):
    s = load_settings(tmp_path / "absent.toml")
    assert s.sample_rate == 32 and s.max_parallel_imports == 2  # 32 images/s : vue du joueur fluide
    assert s.port == 8000 and s.host == "127.0.0.1"
    assert s.db_url.startswith("sqlite:///")


def test_roundtrip(tmp_path: Path):
    p = tmp_path / "config.toml"
    s = Settings(data_dir=tmp_path / "data", demo_folders=[tmp_path / "demos"], sample_rate=24)
    save_settings(s, p)
    s2 = load_settings(p)
    assert s2.sample_rate == 24
    assert s2.demo_folders == [tmp_path / "demos"]
    assert s2.data_dir == tmp_path / "data"
    assert s2.config_path == p


def test_env_data_dir_override(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SKYBOX_DATA_DIR", str(tmp_path / "envdata"))
    s = load_settings(tmp_path / "absent.toml")
    assert s.data_dir == tmp_path / "envdata"
