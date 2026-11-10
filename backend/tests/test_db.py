from sqlalchemy import inspect

from app.core.db import init_db, make_engine


def test_init_db_creates_all_tables(tmp_path):
    url = f"sqlite:///{(tmp_path / 'sub' / 't.db').as_posix()}"
    init_db(url)
    init_db(url)  # idempotent
    names = set(inspect(make_engine(url)).get_table_names())
    assert {"demos", "teams", "players", "matches", "match_players", "rounds", "round_frames", "kills",
            "damages", "shots", "grenades", "bomb_events", "purchases", "blinds", "alembic_version",
            "api_keys", "demo_sources", "webhooks", "webhook_deliveries"} <= names
