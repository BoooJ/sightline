# backend/tests/test_integration_models.py
import pytest
from sqlalchemy.exc import IntegrityError

from app.storage.models import DemoSource


def test_one_request_per_source_and_external_id(db):
    db.add(DemoSource(source="pracc", external_id="u1"))
    db.commit()
    db.add(DemoSource(source="pracc", external_id="u1"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.add(DemoSource(source="faceit", external_id="u1"))  # même identifiant, autre source : permis
    db.commit()
    row = db.query(DemoSource).filter_by(source="faceit").one()
    assert (row.status, row.attempts, row.label) == ("downloading", 0, "{}")
