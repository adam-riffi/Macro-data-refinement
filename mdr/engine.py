"""Deterministic boards and signed, portable refinement sessions.

The browser receives the puzzle geometry but never determines progress. Every
move is validated against a board reconstructed from the signed session seed.
"""

from dataclasses import dataclass, field
import math
import random
import re
import secrets
import time
from typing import Callable
from uuid import uuid4

from itsdangerous import BadData, SignatureExpired, URLSafeTimedSerializer


MODES = {
    "orientation": {"seconds": None, "strikes": 8},
    "standard": {"seconds": 900, "strikes": 5},
    "overtime": {"seconds": 480, "strikes": 3},
}
TEMPERS = ("WO", "FC", "DR", "MA")
TOKEN_MAX_AGE = 86_400
TOKEN_MAX_LENGTH = 8192


class InvalidSession(ValueError):
    """A token is malformed, forged, or contains an invalid game state."""


class ExpiredSession(InvalidSession):
    """A session token is older than the supported resume window."""


class BoardGenerator:
    """Create a reproducible 20 by 10 field with five disjoint 2 by 2 groups."""

    def generate(self, seed: int, round_index: int, collected: list[int]) -> dict:
        rng = random.Random(f"mdr-v1:{seed}:{round_index}")
        cells = [{"id": index, "value": rng.randrange(10)} for index in range(200)]
        # Separate vertical zones keep clusters disjoint and easy to reach.
        zones = list(range(5))
        rng.shuffle(zones)
        clusters = []
        for index, zone in enumerate(zones):
            column = zone * 4 + rng.randrange(3)
            row = rng.randrange(9)
            first = row * 20 + column
            clusters.append({
                "id": f"r{round_index + 1}-b{index + 1}",
                "cells": [first, first + 1, first + 20, first + 21],
                "bin": index + 1,
                "temper": TEMPERS[(index + round_index) % len(TEMPERS)],
                "collected": index + 1 in collected,
            })
        return {"columns": 20, "rows": 10, "cells": cells, "clusters": clusters}


@dataclass
class GameSession:
    """The compact, signed source of truth for one employee's refinement."""

    id: str
    file: str
    mode: str
    seed: int
    started_at: float
    round_index: int = 0
    collected: list[int] = field(default_factory=list)
    score: int = 0
    streak: int = 0
    mistakes: int = 0
    status: str = "active"
    finished_at: float | None = None

    @classmethod
    def new(cls, mode: str = "standard", file: str = "Cold Harbor", *, now: float | None = None) -> "GameSession":
        if not isinstance(mode, str) or mode not in MODES:
            raise ValueError("Choose orientation, standard, or overtime mode.")
        if not isinstance(file, str) or not file.strip() or len(file.strip()) > 48 or not file.isprintable():
            raise ValueError("File names must contain 1–48 printable characters.")
        return cls(uuid4().hex, file.strip(), mode, secrets.randbits(32), time.time() if now is None else now)

    @classmethod
    def from_payload(cls, payload: dict) -> "GameSession":
        expected = {"v", "id", "file", "mode", "seed", "started_at", "round_index", "collected", "score", "streak", "mistakes", "status", "finished_at"}
        if not isinstance(payload, dict) or set(payload) != expected or type(payload["v"]) is not int or payload["v"] != 1:
            raise InvalidSession("This session has an unsupported format.")
        if not isinstance(payload["id"], str) or re.fullmatch(r"[0-9a-f]{32}", payload["id"]) is None:
            raise InvalidSession("This session has an invalid identifier.")
        if not isinstance(payload["mode"], str) or payload["mode"] not in MODES:
            raise InvalidSession("This session has an invalid mode.")
        filename = payload["file"]
        if not isinstance(filename, str) or not 1 <= len(filename) <= 48 or filename != filename.strip() or not filename.isprintable():
            raise InvalidSession("This session has an invalid filename.")
        integer_bounds = {"seed": (0, 2**32 - 1), "round_index": (0, 3), "score": (0, 6750), "streak": (0, 20), "mistakes": (0, MODES[payload["mode"]]["strikes"])}
        for name, (minimum, maximum) in integer_bounds.items():
            if type(payload[name]) is not int or not minimum <= payload[name] <= maximum:
                raise InvalidSession("This session has invalid progress.")
        collected = payload["collected"]
        if not isinstance(collected, list) or len(collected) > 5 or any(type(value) is not int or value not in range(1, 6) for value in collected) or len(set(collected)) != len(collected):
            raise InvalidSession("This session has invalid bin assignments.")
        successful = payload["round_index"] * 5 + len(collected)
        if payload["streak"] > successful or (len(collected) == 5 and payload["round_index"] != 3):
            raise InvalidSession("This session has inconsistent progress.")
        if type(payload["started_at"]) not in (int, float) or not math.isfinite(payload["started_at"]) or payload["started_at"] < 0:
            raise InvalidSession("This session has an invalid start time.")
        finished_at = payload["finished_at"]
        if finished_at is not None and (type(finished_at) not in (int, float) or not math.isfinite(finished_at) or finished_at < payload["started_at"]):
            raise InvalidSession("This session has an invalid finish time.")
        status = payload["status"]
        if status not in ("active", "completed", "failed") or (status == "active") != (finished_at is None):
            raise InvalidSession("This session has an invalid status.")
        if (status == "completed") != (successful == 20) or (status == "active" and payload["mistakes"] >= MODES[payload["mode"]]["strikes"]):
            raise InvalidSession("This session has inconsistent completion data.")
        return cls(**{key: value for key, value in payload.items() if key != "v"})

    def to_payload(self) -> dict:
        return {"v": 1, "id": self.id, "file": self.file, "mode": self.mode, "seed": self.seed, "started_at": self.started_at, "round_index": self.round_index, "collected": list(self.collected), "score": self.score, "streak": self.streak, "mistakes": self.mistakes, "status": self.status, "finished_at": self.finished_at}

    def refresh(self, now: float) -> None:
        duration = MODES[self.mode]["seconds"]
        if self.status == "active" and duration is not None and now >= self.started_at + duration:
            self.status = "failed"
            self.finished_at = self.started_at + duration

    def refine(self, cells: list[int], bin_id: int, now: float) -> dict:
        if not isinstance(cells, list) or len(cells) > 200 or any(type(cell) is not int or not 0 <= cell < 200 for cell in cells) or len(set(cells)) != len(cells):
            raise ValueError("Selection must contain unique cell numbers from 0 to 199.")
        if type(bin_id) is not int or bin_id not in range(1, 6):
            raise ValueError("Choose a bin from 1 to 5.")
        self.refresh(now)
        if self.status != "active":
            return {"accepted": False, "message": "This file is closed. Begin a new refinement to continue."}
        board = BoardGenerator().generate(self.seed, self.round_index, self.collected)
        match = next((cluster for cluster in board["clusters"] if set(cluster["cells"]) == set(cells)), None)
        if match is not None and match["collected"]:
            return {"accepted": False, "message": "This group has already been refined."}
        if match is None or match["bin"] != bin_id:
            self.mistakes += 1
            self.streak = 0
            self.score = max(0, self.score - 50)
            if self.mistakes >= MODES[self.mode]["strikes"]:
                self.status = "failed"
                self.finished_at = max(self.started_at, now)
            return {"accepted": False, "message": "The numbers do not belong in that bin. One strike recorded."}
        self.score += 100 + self.streak * 25
        self.streak += 1
        self.collected.append(bin_id)
        if len(self.collected) == 5:
            if self.round_index == 3:
                self.status = "completed"
                self.finished_at = max(self.started_at, now)
            else:
                self.round_index += 1
                self.collected = []
        message = "File complete. Your work has been acknowledged." if self.status == "completed" else f"Bin {bin_id:02d} accepted. The department thanks you."
        return {"accepted": True, "message": message}

    def to_public(self, now: float) -> dict:
        self.refresh(now)
        end = self.finished_at if self.finished_at is not None else max(self.started_at, now)
        elapsed = max(0, int(end - self.started_at))
        duration = MODES[self.mode]["seconds"]
        counts = [self.round_index + int(bin_id in self.collected) for bin_id in range(1, 6)]
        return {
            "id": self.id, "file": self.file, "mode": self.mode, "status": self.status,
            "score": self.score, "streak": self.streak, "mistakes": self.mistakes,
            "max_mistakes": MODES[self.mode]["strikes"], "progress": sum(counts) * 5,
            "round": self.round_index + 1, "rounds": 4, "elapsed_seconds": elapsed,
            "remaining_seconds": None if duration is None else max(0, duration - elapsed),
            "bins": [{"id": index + 1, "progress": count * 25, "count": count, "capacity": 4} for index, count in enumerate(counts)],
            "board": BoardGenerator().generate(self.seed, self.round_index, self.collected),
        }


class SessionService:
    """Sign game state so serverless workers need no shared memory or database."""

    def __init__(self, secret: str, clock: Callable[[], float] = time.time):
        if not isinstance(secret, str) or len(secret) < 32:
            raise ValueError("A session secret of at least 32 characters is required.")
        self.serializer = URLSafeTimedSerializer(secret, salt="mdr-session-v1")
        self.clock = clock

    def encode(self, session: GameSession) -> dict:
        state = session.to_public(self.clock())
        return {"token": self.serializer.dumps(session.to_payload()), "state": state}

    def decode(self, token: str) -> GameSession:
        if not isinstance(token, str) or not token or len(token) > TOKEN_MAX_LENGTH:
            raise InvalidSession("Provide a valid session token.")
        try:
            payload = self.serializer.loads(token, max_age=TOKEN_MAX_AGE)
        except SignatureExpired as error:
            raise ExpiredSession("This saved session has expired. Begin a new refinement.") from error
        except BadData as error:
            raise InvalidSession("This saved session could not be verified.") from error
        session = GameSession.from_payload(payload)
        now = self.clock()
        if session.started_at > now + 60:
            raise InvalidSession("This session has an invalid start time.")
        session.refresh(now)
        return session
