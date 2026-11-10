# backend/app/storage/models.py
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, LargeBinary, String, Text,
                        UniqueConstraint, func)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base

FK_ROUND = "rounds.id"


class Demo(Base):
    __tablename__ = "demos"
    id: Mapped[int] = mapped_column(primary_key=True)
    path: Mapped[str] = mapped_column(Text)
    file_name: Mapped[str] = mapped_column(String(512))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    step: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    parser_version: Mapped[str | None] = mapped_column(String(16), nullable=True)
    sample_rate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    imported_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    label: Mapped["MatchLabel | None"] = relationship(cascade="all, delete-orphan", passive_deletes=True, uselist=False)
    match: Mapped["Match | None"] = relationship(back_populates="demo", cascade="all, delete-orphan",
                                                 passive_deletes=True, uselist=False)


class Team(Base):
    __tablename__ = "teams"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)


class Player(Base):
    __tablename__ = "players"
    steamid: Mapped[str] = mapped_column(String(20), primary_key=True)
    last_name: Mapped[str] = mapped_column(String(128))


class Match(Base):
    __tablename__ = "matches"
    id: Mapped[int] = mapped_column(primary_key=True)
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), unique=True)
    map_name: Mapped[str] = mapped_column(String(64), index=True)
    server_name: Mapped[str] = mapped_column(String(256), default="")
    played_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    demo_tickrate: Mapped[int] = mapped_column(Integer)
    sample_rate: Mapped[int] = mapped_column(Integer)
    team_a_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    team_b_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    score_a: Mapped[int] = mapped_column(Integer)
    score_b: Mapped[int] = mapped_column(Integer)
    rounds_count: Mapped[int] = mapped_column(Integer)
    duration_s: Mapped[float] = mapped_column(Float)
    demo: Mapped[Demo] = relationship(back_populates="match")
    team_a: Mapped[Team] = relationship(foreign_keys=[team_a_id])
    team_b: Mapped[Team] = relationship(foreign_keys=[team_b_id])
    rounds: Mapped[list["Round"]] = relationship(back_populates="match", cascade="all, delete-orphan",
                                                 passive_deletes=True, order_by="Round.number")
    players: Mapped[list["MatchPlayer"]] = relationship(cascade="all, delete-orphan", passive_deletes=True)


class MatchPlayer(Base):
    __tablename__ = "match_players"
    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"), index=True)
    steamid: Mapped[str] = mapped_column(ForeignKey("players.steamid"), index=True)
    name_in_match: Mapped[str] = mapped_column(String(128))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    starting_side: Mapped[str] = mapped_column(String(2))


class Round(Base):
    __tablename__ = "rounds"
    __table_args__ = (UniqueConstraint("match_id", "number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    start_tick: Mapped[int] = mapped_column(Integer)
    freeze_end_tick: Mapped[int] = mapped_column(Integer)
    end_tick: Mapped[int] = mapped_column(Integer)
    winner_side: Mapped[str | None] = mapped_column(String(2), nullable=True)
    end_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ct_team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    t_team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    score_ct_before: Mapped[int] = mapped_column(Integer)
    score_t_before: Mapped[int] = mapped_column(Integer)
    ct_equip_value: Mapped[int] = mapped_column(Integer)
    t_equip_value: Mapped[int] = mapped_column(Integer)
    ct_buy_type: Mapped[str] = mapped_column(String(8))
    t_buy_type: Mapped[str] = mapped_column(String(8))
    match: Mapped[Match] = relationship(back_populates="rounds")


class RoundFrames(Base):
    __tablename__ = "round_frames"
    round_id: Mapped[int] = mapped_column(ForeignKey(FK_ROUND, ondelete="CASCADE"), primary_key=True)
    codec_version: Mapped[int] = mapped_column(Integer)
    tick_count: Mapped[int] = mapped_column(Integer)
    blob: Mapped[bytes] = mapped_column(LargeBinary)


def _round_fk() -> Mapped[int]:
    return mapped_column(ForeignKey(FK_ROUND, ondelete="CASCADE"), index=True)


class Kill(Base):
    __tablename__ = "kills"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = _round_fk()
    tick: Mapped[int] = mapped_column(Integer)
    attacker: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    victim: Mapped[str] = mapped_column(String(20), index=True)
    assister: Mapped[str | None] = mapped_column(String(20), nullable=True)
    attacker_side: Mapped[str | None] = mapped_column(String(2), nullable=True)
    victim_side: Mapped[str | None] = mapped_column(String(2), nullable=True)
    flash_assist: Mapped[bool] = mapped_column(Boolean, default=False)
    weapon: Mapped[str] = mapped_column(String(64))
    headshot: Mapped[bool] = mapped_column(Boolean)
    penetrated: Mapped[int] = mapped_column(Integer)
    through_smoke: Mapped[bool] = mapped_column(Boolean)
    noscope: Mapped[bool] = mapped_column(Boolean)
    attacker_blind: Mapped[bool] = mapped_column(Boolean)
    attacker_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    attacker_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    attacker_z: Mapped[float | None] = mapped_column(Float, nullable=True)
    victim_x: Mapped[float] = mapped_column(Float)
    victim_y: Mapped[float] = mapped_column(Float)
    victim_z: Mapped[float] = mapped_column(Float)
    is_opening: Mapped[bool] = mapped_column(Boolean, default=False)
    is_trade: Mapped[bool] = mapped_column(Boolean, default=False)
    traded_player: Mapped[str | None] = mapped_column(String(20), nullable=True)
    attacker_place: Mapped[str | None] = mapped_column(String(64), nullable=True)
    victim_place: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Damage(Base):
    __tablename__ = "damages"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = _round_fk()
    tick: Mapped[int] = mapped_column(Integer)
    attacker: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    victim: Mapped[str] = mapped_column(String(20))
    attacker_side: Mapped[str | None] = mapped_column(String(2), nullable=True)
    victim_side: Mapped[str | None] = mapped_column(String(2), nullable=True)
    weapon: Mapped[str] = mapped_column(String(64))
    dmg_health: Mapped[int] = mapped_column(Integer)
    dmg_health_real: Mapped[int] = mapped_column(Integer)
    dmg_armor: Mapped[int] = mapped_column(Integer)
    hitgroup: Mapped[str] = mapped_column(String(32))


class Shot(Base):
    __tablename__ = "shots"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = _round_fk()
    tick: Mapped[int] = mapped_column(Integer)
    shooter: Mapped[str] = mapped_column(String(20))
    weapon: Mapped[str] = mapped_column(String(64))
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    yaw: Mapped[float] = mapped_column(Float)
    pitch: Mapped[float] = mapped_column(Float)
    speed: Mapped[float | None] = mapped_column(Float, nullable=True)


class Grenade(Base):
    __tablename__ = "grenades"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = _round_fk()
    type: Mapped[str] = mapped_column(String(16), index=True)
    thrower: Mapped[str] = mapped_column(String(20), index=True)
    throw_tick: Mapped[int] = mapped_column(Integer)
    throw_x: Mapped[float] = mapped_column(Float)
    throw_y: Mapped[float] = mapped_column(Float)
    throw_z: Mapped[float] = mapped_column(Float)
    throw_yaw: Mapped[float | None] = mapped_column(Float, nullable=True)
    throw_pitch: Mapped[float | None] = mapped_column(Float, nullable=True)
    trajectory: Mapped[bytes] = mapped_column(LargeBinary)  # msgpack [[tick,x,y,z],...] (zstd)
    detonate_tick: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detonate_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    detonate_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    detonate_z: Mapped[float | None] = mapped_column(Float, nullable=True)
    end_tick: Mapped[int | None] = mapped_column(Integer, nullable=True)


class BombEvent(Base):
    __tablename__ = "bomb_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = _round_fk()
    tick: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(16))
    player: Mapped[str | None] = mapped_column(String(20), nullable=True)
    site: Mapped[str | None] = mapped_column(String(4), nullable=True)
    x: Mapped[float | None] = mapped_column(Float, nullable=True)
    y: Mapped[float | None] = mapped_column(Float, nullable=True)
    z: Mapped[float | None] = mapped_column(Float, nullable=True)


class Purchase(Base):
    __tablename__ = "purchases"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = _round_fk()
    tick: Mapped[int] = mapped_column(Integer)
    player: Mapped[str] = mapped_column(String(20), index=True)
    item: Mapped[str] = mapped_column(String(64))
    cost: Mapped[int] = mapped_column(Integer)


class Blind(Base):
    __tablename__ = "blinds"
    id: Mapped[int] = mapped_column(primary_key=True)
    round_id: Mapped[int] = _round_fk()
    tick: Mapped[int] = mapped_column(Integer)
    attacker: Mapped[str | None] = mapped_column(String(20), nullable=True)
    victim: Mapped[str] = mapped_column(String(20))
    duration: Mapped[float] = mapped_column(Float)


Index("ix_kills_round_tick", Kill.round_id, Kill.tick)


class Playlist(Base):
    """Sélection ordonnée de rounds (sous-projet 3). Les éléments visent (démo, numéro de round) et non l'id du round :
    une ré-analyse recrée les rounds, la playlist doit y survivre."""
    __tablename__ = "playlists"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")
    folder: Mapped[str] = mapped_column(String(128), default="")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    tags: Mapped[str] = mapped_column(Text, default="[]")  # JSON : liste de chaînes
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    items: Mapped[list["PlaylistItem"]] = relationship(cascade="all, delete-orphan", passive_deletes=True,
                                                       order_by="PlaylistItem.position")


class PlaylistItem(Base):
    __tablename__ = "playlist_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id", ondelete="CASCADE"), index=True)
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), index=True)
    round_number: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(Text, default="")


class Annotation(Base):
    """Dessins et note d'un round (sous-projet 6), indexés par (démo, numéro de round) pour survivre aux ré-analyses.
    `data` = JSON {"shapes": [...], "note": "..."} ; les formes sont en px radar, par niveau de carte."""
    __tablename__ = "annotations"
    __table_args__ = (UniqueConstraint("demo_id", "round_number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), index=True)
    round_number: Mapped[int] = mapped_column(Integer)
    data: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


# --------------------------------------------------------------------------- espace d'équipe (sous-projet 7)
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="member")  # owner / admin / member
    steamid: Mapped[str | None] = mapped_column(String(20), nullable=True)  # joueur lié (tableau de bord)
    ts_nickname: Mapped[str | None] = mapped_column(String(64), nullable=True)  # pseudo TeamSpeak (pistes de comms)
    comparison: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON : référence de comparaison (équipes / soi, mois)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Invite(Base):
    __tablename__ = "invites"
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[str] = mapped_column(String(16), default="member")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Comment(Base):
    """Commentaire sur un match, éventuellement un round et un instant ; indexé par démo (survit aux ré-analyses)."""
    __tablename__ = "comments"
    id: Mapped[int] = mapped_column(primary_key=True)
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), index=True)
    round_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tick: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    body: Mapped[str] = mapped_column(Text)
    private: Mapped[bool] = mapped_column(Boolean, default=False)  # visible par son auteur seulement
    shapes: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON : dessin joint au commentaire
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class MatchAudio(Base):
    """Piste de communications vocales d'un match (fichier audio et décalage par rapport à la démo)."""
    __tablename__ = "match_audio"
    id: Mapped[int] = mapped_column(primary_key=True)
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(64))
    file_name: Mapped[str] = mapped_column(String(256))
    path: Mapped[str] = mapped_column(Text)
    offset_s: Mapped[float] = mapped_column(Float, default=0.0)  # temps audio = temps démo + offset_s
    steamid: Mapped[str | None] = mapped_column(String(32), nullable=True)  # joueur dont c'est la voix (piste par joueur)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PrepTemplate(Base):
    """Template de rapport de préparation (Match Prep) : liste ordonnée de widgets (JSON), partagé avec l'équipe ou privé."""
    __tablename__ = "prep_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    widgets: Mapped[str] = mapped_column(Text, default="[]")
    shared: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PrepReport(Base):
    """Rapport de préparation généré pour un adversaire et une carte : contenu figé (JSON des widgets) + notes."""
    __tablename__ = "prep_reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    map_name: Mapped[str] = mapped_column(String(64))
    template_id: Mapped[int | None] = mapped_column(ForeignKey("prep_templates.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    content: Mapped[str] = mapped_column(Text, default="{}")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class VetoRecord(Base):
    """Veto réel d'un match (séquence pick / ban saisie par l'équipe) : statistiques Pick / Ban / Played et prédictions."""
    __tablename__ = "veto_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    team_a_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    team_b_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    format: Mapped[str] = mapped_column(String(8), default="bo3")
    steps: Mapped[str] = mapped_column(Text, default="[]")  # JSON : [{"team": "a"|"b", "action": "ban"|"pick"|"decider", "map": ...}]
    match_id: Mapped[int | None] = mapped_column(ForeignKey("matches.id", ondelete="SET NULL"), nullable=True)
    played_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Shortlist(Base):
    """Shortlist de joueurs (scouting tool) : joueurs repérés dans la bibliothèque, avec une note."""
    __tablename__ = "shortlists"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    items: Mapped[list["ShortlistItem"]] = relationship(cascade="all, delete-orphan", passive_deletes=True)


class ShortlistItem(Base):
    __tablename__ = "shortlist_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    shortlist_id: Mapped[int] = mapped_column(ForeignKey("shortlists.id", ondelete="CASCADE"), index=True)
    steamid: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(128), default="")
    note: Mapped[str] = mapped_column(String(300), default="")
    added_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PushSubscription(Base):
    """Un appareil abonné aux notifications web (app mobile installée sur l'écran d'accueil)."""
    __tablename__ = "push_subscriptions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    endpoint: Mapped[str] = mapped_column(String(1024), unique=True)
    p256dh: Mapped[str] = mapped_column(String(256))
    auth: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Notification(Base):
    """Notification d'équipe (match prêt, commentaire, rapport de préparation…), visible par tous ; lue = repère local."""
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(String(500), default="")
    link: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ShareLink(Base):
    """Lien public vers un instant du replay (round, tick, rounds superposés du même match), valable 30 jours."""
    __tablename__ = "share_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    token: Mapped[str] = mapped_column(String(48), unique=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"), index=True)
    round_number: Mapped[int] = mapped_column(Integer)
    tick: Mapped[int] = mapped_column(Integer, default=0)
    layers: Mapped[str] = mapped_column(Text, default="[]")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class MatchLabel(Base):
    """Organisation de la bibliothèque : dossier, événement, étiquettes et date de jeu d'une démo (survit aux ré-analyses)."""
    __tablename__ = "match_labels"
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), primary_key=True)
    folder: Mapped[str] = mapped_column(String(128), default="")
    event: Mapped[str] = mapped_column(String(128), default="")
    tags: Mapped[str] = mapped_column(Text, default="[]")  # JSON : liste de chaînes
    played_on: Mapped[date | None] = mapped_column(Date, nullable=True)


class Strat(Base):
    """Stratbook d'équipe : une tactique (positions, grenades, dessins et notes) pour une carte et un camp."""
    __tablename__ = "strats"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    map_name: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str] = mapped_column(String(2))
    type: Mapped[str] = mapped_column(String(16), default="other")
    description: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[str] = mapped_column(Text, default="[]")
    positions: Mapped[str] = mapped_column(Text, default="[]")
    grenades: Mapped[str] = mapped_column(Text, default="[]")
    shapes: Mapped[str] = mapped_column(Text, default="[]")
    source: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON {match_id, round_number, tick}
    roles: Mapped[str] = mapped_column(Text, default="[]")  # JSON [{player, call}] : la consigne de chaque joueur
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)  # ready | wip
    category: Mapped[str | None] = mapped_column(String(24), nullable=True)  # code couleur de l'équipe (pistol, force…)
    links: Mapped[str] = mapped_column(Text, default="[]")  # JSON [{url, label}] : démo, replay, clip de référence
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class PlaybookEntry(Base):
    """Mémo d'équipe du stratbook : lexique des annonces (codeword), rappels de jeu (rule), rôles par carte (roles) et
    notes libres (note). Commun à toute l'équipe, rangé par `position`."""
    __tablename__ = "playbook_entries"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text, default="")
    map_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    side: Mapped[str | None] = mapped_column(String(2), nullable=True)
    link: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Tactic(Base):
    """Tactique du playbook (sous-projet F) : conditions (zones, utilitaires, pose, contact, fenêtres de temps) détectées
    automatiquement dans les rounds de n'importe quelle équipe, par carte et par camp."""
    __tablename__ = "tactics"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    map_name: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str] = mapped_column(String(2))
    category: Mapped[str] = mapped_column(String(32), default="mid_round")
    tags: Mapped[str] = mapped_column(Text, default="[]")
    description: Mapped[str] = mapped_column(Text, default="")
    definition: Mapped[str] = mapped_column(Text, default="{}")  # JSON {conditions: [...]}
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Callout(Base):
    """Nom d'un lieu de la carte dans le vocabulaire de l'équipe (remplace le nom du jeu à l'affichage)."""
    __tablename__ = "callouts"
    __table_args__ = (UniqueConstraint("map_name", "place"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    map_name: Mapped[str] = mapped_column(String(64))
    place: Mapped[str] = mapped_column(String(64))  # lieu du jeu, ou « @<id> » pour un callout placé à la main
    label: Mapped[str] = mapped_column(String(64))
    # callout placé à la main : position (unités du jeu) ; les morts proches prennent ce nom
    x: Mapped[float | None] = mapped_column(Float, nullable=True)
    y: Mapped[float | None] = mapped_column(Float, nullable=True)
    z: Mapped[float | None] = mapped_column(Float, nullable=True)


class CalendarEvent(Base):
    """Calendrier de l'équipe : matchs officiels, scrims, tournois, entraînements. Les démos jouées ce jour-là contre
    l'adversaire indiqué sont rattachées automatiquement ; `match_ids` ajoute des rattachements manuels."""
    __tablename__ = "calendar_events"
    __table_args__ = (UniqueConstraint("source", "external_id", name="uq_calendar_events_source_external_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16), default="match")
    opponent: Mapped[str] = mapped_column(String(128), default="")
    maps: Mapped[str] = mapped_column(Text, default="[]")
    starts_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    match_ids: Mapped[str] = mapped_column(Text, default="[]")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # événement venu d'une source (PRACC, via l'extension et n8n) : mis à jour, et retiré s'il y disparaît
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    announced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # message de prép envoyé (W5)
    # match FACEIT : cartes probables (JSON, app.integrations.map_odds), recalculées par la synchro W6
    map_odds: Mapped[str | None] = mapped_column(Text, nullable=True)
    map_odds_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    demos_requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # démos de l'adversaire en file


class Bookmark(Base):
    """Signet personnel : un instant d'un round, retrouvé en un clic (indexé par démo : survit aux ré-analyses)."""
    __tablename__ = "bookmarks"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), index=True)
    round_number: Mapped[int] = mapped_column(Integer)
    tick: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Note(Base):
    """Note courte d'un joueur : rangée sous une carte, éventuellement un camp, un match, un adversaire ou une stratégie.
    Privée par défaut, partagée avec l'équipe sur demande. Survit à la suppression de ce qu'elle vise (SET NULL)."""
    __tablename__ = "notes"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    map_name: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str | None] = mapped_column(String(2), nullable=True)  # T, CT, ou None pour les deux camps
    body: Mapped[str] = mapped_column(Text)
    shared: Mapped[bool] = mapped_column(Boolean, default=False)
    match_id: Mapped[int | None] = mapped_column(ForeignKey("matches.id", ondelete="SET NULL"), nullable=True, index=True)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"), nullable=True, index=True)
    strat_id: Mapped[int | None] = mapped_column(ForeignKey("strats.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class FaceitTeam(Base):
    """Équipe FACEIT suivie pour le scouting (saison ESEA…). `steamids` : joueurs vus dans ses matchs (JSON), qui
    servent à rattacher les démos importées à l'équipe locale du même nom."""
    __tablename__ = "faceit_teams"
    team_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    avatar: Mapped[str] = mapped_column(String(512), default="")
    steamids: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class FaceitDemo(Base):
    """Démo importée d'un match FACEIT (une par carte d'un BO3)."""
    __tablename__ = "faceit_demos"
    demo_id: Mapped[int] = mapped_column(ForeignKey("demos.id", ondelete="CASCADE"), primary_key=True)
    match_id: Mapped[str] = mapped_column(String(64), index=True)


class ScoutingReport(Base):
    """Rapport de scouting rédigé par l'IA à partir de la fiche de faits (app.stats.facts), vérifié en code.
    `content` : JSON {sections: [{key, title, map, blocks: [{title, text, fact_ids}]}], facts: {...}} ;
    `checks` : JSON du contrôle (nombres vérifiés, phrases retirées…)."""
    __tablename__ = "scouting_reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="running")  # running | done | error
    model: Mapped[str] = mapped_column(String(64), default="")
    content: Mapped[str] = mapped_column(Text, default="{}")
    checks: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    latency_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CoachNote(Base):
    """Explication rédigée par l'IA (« Apprendre un rôle ») : récit d'un round ou guide d'un poste, gardée en cache
    pour ne payer qu'une fois. `key` : type + démo(s) + joueur + camp + round."""
    __tablename__ = "coach_notes"
    key: Mapped[str] = mapped_column(String(160), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="{}")
    model: Mapped[str] = mapped_column(String(64), default="")
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class MatchDebrief(Base):
    """Conclusions d'une équipe après un match (débrief) : ce qui a marché, ce qu'il faut changer, actions pour le
    prochain entraînement. Une ligne par (match, équipe)."""
    __tablename__ = "match_debriefs"
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"), primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True)
    worked: Mapped[str] = mapped_column(Text, default="")
    change: Mapped[str] = mapped_column(Text, default="")
    actions: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class TeamGoal(Base):
    """Axe de travail d'une équipe, relié à une mesure calculée à chaque match (app.stats.debrief.METRICS) : on compare
    les matchs joués avant et après sa création pour voir si le changement prend."""
    __tablename__ = "team_goals"
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    metric: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(160))
    note: Mapped[str] = mapped_column(Text, default="")
    target: Mapped[float | None] = mapped_column(Float, nullable=True)  # en %, dans le sens de la mesure
    source_match_id: Mapped[int | None] = mapped_column(ForeignKey("matches.id", ondelete="SET NULL"), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ApiKey(Base):
    """Clé d'API d'un outil externe (n8n…) : seule son empreinte SHA-256 est stockée. `scopes` (JSON) limite les routes
    permises (app.integrations.keys.allows) ; une clé ne donne aucun droit de compte."""
    __tablename__ = "api_keys"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    prefix: Mapped[str] = mapped_column(String(16))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    scopes: Mapped[str] = mapped_column(Text, default="[]")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class DemoSource(Base):
    """Démo demandée par un outil externe, repérée par son identifiant chez la source (PRACC…), avant même le
    téléchargement : un même prac n'est jamais importé deux fois. `label` (JSON) : étiquette posée sur la démo créée."""
    __tablename__ = "demo_sources"
    __table_args__ = (UniqueConstraint("source", "external_id", name="uq_demo_sources_source_external_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(16))
    external_id: Mapped[str] = mapped_column(String(128))
    demo_id: Mapped[int | None] = mapped_column(ForeignKey("demos.id", ondelete="SET NULL"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default="downloading")  # downloading / importing / done / error / abandoned
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class CommsSession(Base):
    """Comms TeamSpeak d'une map, envoyées par le plugin Sightline (pistes Opus, débuts des rounds lus par la GSI de
    CS2) : en attente de leur match, puis rattachées (pistes match_audio calées sur la démo)."""
    __tablename__ = "comms_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="waiting")  # waiting / attached / expired / error
    recorder_steamid: Mapped[str | None] = mapped_column(String(20), nullable=True)
    map_name: Mapped[str] = mapped_column(String(64), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime)
    payload: Mapped[str] = mapped_column(Text)  # session.json validé (comms.clean_session)
    folder: Mapped[str] = mapped_column(Text)
    match_id: Mapped[int | None] = mapped_column(ForeignKey("matches.id", ondelete="SET NULL"), nullable=True)
    offset_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Webhook(Base):
    """Webhook sortant : les événements choisis (`events`, JSON) partent en POST signé par un JWT HS256 (`secret`)."""
    __tablename__ = "webhooks"
    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(String(512))
    secret: Mapped[str] = mapped_column(String(64))
    events: Mapped[str] = mapped_column(Text, default="[]")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class WebhookDelivery(Base):
    """Un essai d'envoi d'un webhook (journal : les 200 derniers)."""
    __tablename__ = "webhook_deliveries"
    id: Mapped[int] = mapped_column(primary_key=True)
    webhook_id: Mapped[int] = mapped_column(ForeignKey("webhooks.id", ondelete="CASCADE"), index=True)
    event: Mapped[str] = mapped_column(String(32))
    delivery_id: Mapped[str] = mapped_column(String(32))
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
