"""Version-two explorable refinement worlds and bounded, signed run state."""

from dataclasses import asdict, dataclass, field
import math
import random
import re
import secrets
import time
from uuid import uuid4

from itsdangerous import BadData, SignatureExpired, URLSafeTimedSerializer

from .engine import ExpiredSession, InvalidSession, SessionService, TOKEN_MAX_AGE

MODES = ("quota", "timed", "endless")
DIFFICULTIES = ("normal", "quota_achiever", "quarter_refiner")
COLUMNS, ROWS, SLOTS, QUOTA = 256, 160, 80, 100


class WorldGenerator:
    """Independent regions keep all cluster generations disjoint and reproducible."""

    def cluster(self, seed: int, slot: int, generation: int, active: bool = True) -> dict:
        rng = random.Random(f"mdr-world-v2:{seed}:{slot}:{generation}")
        size = rng.randint(3, 18)
        points = size * 10 + rng.randrange(10)
        origin_x = (slot % 8) * 32 + (generation % 2) * 16
        origin_y = (slot // 8) * 16
        cells = {(rng.randint(4, 11), rng.randint(4, 11))}
        while len(cells) < size:
            frontier = {
                (x + dx, y + dy)
                for x, y in cells for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                if 2 <= x + dx <= 13 and 2 <= y + dy <= 13
            } - cells
            cells.add(rng.choice(sorted(frontier)))
        return {
            "id": f"{slot}:{generation}", "slot": slot, "generation": generation,
            "cells": sorted((origin_y + y) * COLUMNS + origin_x + x for x, y in cells),
            "bin": slot % 5 + 1, "points": points,
            "temper": ("WO", "FC", "DR", "MA")[(slot + generation) % 4], "active": active,
        }

    def generate(self, session: "WorldSession") -> dict:
        return {
            "columns": COLUMNS, "rows": ROWS, "seed": session.seed,
            "clusters": [self.cluster(session.seed, slot, generation,
                session.status == "active" and session.counts[slot % 5] < QUOTA)
                for slot, generation in enumerate(session.generations)],
        }


@dataclass
class WorldSession:
    """Capture history is represented by eighty counters, including in endless mode."""

    id: str
    file: str
    mode: str
    difficulty: str
    seed: int
    started_at: float
    generations: list[int] = field(default_factory=lambda: [0] * SLOTS)
    counts: list[int] = field(default_factory=lambda: [0] * 5)
    score: int = 0
    refined_digits: int = 0
    captured_clusters: int = 0
    mistakes: int = 0
    cycle: int = 1
    revision: int = 0
    status: str = "active"
    finished_at: float | None = None

    @classmethod
    def new(cls, mode="quota", difficulty="normal", file="Cold Harbor", now=None):
        if mode not in MODES or difficulty not in DIFFICULTIES:
            raise ValueError("Choose a supported gameplay mode and difficulty.")
        if not isinstance(file, str) or not file.isprintable() or not 1 <= len(file.strip()) <= 48:
            raise ValueError("File names must contain 1–48 printable characters.")
        return cls(uuid4().hex, file.strip(), mode, difficulty, secrets.randbits(32), time.time() if now is None else now)

    def to_payload(self):
        return {"v": 2, **asdict(self)}

    @classmethod
    def from_payload(cls, payload):
        expected = {"v", "id", "file", "mode", "difficulty", "seed", "started_at", "generations", "counts", "score", "refined_digits", "captured_clusters", "mistakes", "cycle", "revision", "status", "finished_at"}
        if not isinstance(payload, dict) or set(payload) != expected or type(payload["v"]) is not int or payload["v"] != 2:
            raise InvalidSession("Unsupported world save format.")
        if not isinstance(payload["id"], str) or not re.fullmatch(r"[0-9a-f]{32}", payload["id"]):
            raise InvalidSession("Invalid world identifier.")
        if payload["mode"] not in MODES or payload["difficulty"] not in DIFFICULTIES:
            raise InvalidSession("Invalid gameplay settings.")
        filename = payload["file"]
        if not isinstance(filename, str) or not filename.isprintable() or filename != filename.strip() or not 1 <= len(filename) <= 48:
            raise InvalidSession("Invalid world filename.")
        for key, low, high in (("seed", 0, 2**32 - 1), ("score", 0, 10**14), ("refined_digits", 0, 10**13), ("captured_clusters", 0, 10**12), ("mistakes", 0, 3), ("cycle", 1, 10**10), ("revision", 0, 10**13)):
            if type(payload[key]) is not int or not low <= payload[key] <= high:
                raise InvalidSession("Invalid world counters.")
        for key, length, maximum in (("generations", SLOTS, 10**9), ("counts", 5, QUOTA)):
            values = payload[key]
            if not isinstance(values, list) or len(values) != length or any(type(value) is not int or not 0 <= value <= maximum for value in values):
                raise InvalidSession("Invalid world region data.")
        captures = payload["captured_clusters"]
        if sum(payload["generations"]) != captures or payload["revision"] < captures or not captures * 3 <= payload["refined_digits"] <= captures * 18 or payload["score"] > captures * 189:
            raise InvalidSession("Inconsistent refinement totals.")
        if payload["difficulty"] != "quarter_refiner" and payload["mistakes"] != 0:
            raise InvalidSession("Unexpected strikes for this difficulty.")
        started, finished = payload["started_at"], payload["finished_at"]
        if type(started) not in (int, float) or not math.isfinite(started) or started < 0:
            raise InvalidSession("Invalid world timestamp.")
        if finished is not None and (type(finished) not in (int, float) or not math.isfinite(finished) or finished < started):
            raise InvalidSession("Invalid finish timestamp.")
        status = payload["status"]
        if status not in ("active", "completed", "failed") or (status == "active") != (finished is None):
            raise InvalidSession("Invalid world status.")
        complete = sum(payload["counts"]) == 5 * QUOTA
        if (status == "completed") != (complete and payload["mode"] != "endless") or (status == "active" and payload["mistakes"] == 3) or (payload["mode"] == "endless" and complete):
            raise InvalidSession("Inconsistent world completion.")
        return cls(**{key: value for key, value in payload.items() if key != "v"})

    def refresh(self, now):
        if self.status == "active" and self.mode == "timed" and now >= self.started_at + 900:
            self.status = "failed"
            self.finished_at = self.started_at + 900

    def capture(self, cluster_id, now):
        if not isinstance(cluster_id, str) or not re.fullmatch(r"\d{1,2}:\d{1,10}", cluster_id):
            raise ValueError("Provide a valid cluster identifier.")
        self.refresh(now)
        slot, generation = map(int, cluster_id.split(":"))
        if self.status != "active" or slot >= SLOTS or self.generations[slot] != generation or self.counts[slot % 5] >= QUOTA:
            return {"accepted": False, "message": "This group is no longer available.", "points": 0, "bin": None, "cells": []}
        cluster = WorldGenerator().cluster(self.seed, slot, generation)
        self.generations[slot] += 1
        self.captured_clusters += 1
        self.refined_digits += len(cluster["cells"])
        self.counts[slot % 5] = min(QUOTA, self.counts[slot % 5] + len(cluster["cells"]))
        self.score += cluster["points"]
        self.revision += 1
        if all(count >= QUOTA for count in self.counts):
            if self.mode == "endless":
                self.cycle += 1
                self.counts = [0] * 5
            else:
                self.status = "completed"
                self.finished_at = max(now, self.started_at)
        return {"accepted": True, "message": f"{len(cluster['cells'])} numbers refined. Bin {cluster['bin']:02d}.", "points": cluster["points"], "bin": cluster["bin"], "cells": cluster["cells"], "replacement_generation": generation + 1}

    def mistake(self, cell, now):
        if type(cell) is not int or not 0 <= cell < COLUMNS * ROWS:
            raise ValueError("Choose a cell inside the number field.")
        self.refresh(now)
        if self.status != "active" or any(cell in cluster["cells"] for cluster in WorldGenerator().generate(self)["clusters"]):
            return {"accepted": False, "message": "Let the numbers gather before refining.", "points": 0, "bin": None, "cells": []}
        penalty = 0
        if self.difficulty == "quota_achiever":
            penalty = min(50, self.score)
            self.score -= penalty
        elif self.difficulty == "quarter_refiner":
            self.mistakes += 1
            if self.mistakes == 3:
                self.status = "failed"
                self.finished_at = max(now, self.started_at)
        self.revision += 1
        return {"accepted": False, "message": "These numbers do not require refinement.", "points": -penalty, "bin": None, "cells": []}

    def to_public(self, now):
        self.refresh(now)
        elapsed = int(max(0, (self.finished_at if self.finished_at is not None else now) - self.started_at))
        return {
            "id": self.id, "file": self.file, "mode": self.mode, "difficulty": self.difficulty,
            "status": self.status, "score": self.score, "mistakes": self.mistakes,
            "max_mistakes": 3 if self.difficulty == "quarter_refiner" else None,
            "progress": sum(self.counts) / 5, "cycle": self.cycle,
            "refined_digits": self.refined_digits, "captured_clusters": self.captured_clusters,
            "elapsed_seconds": elapsed, "remaining_seconds": max(0, 900 - elapsed) if self.mode == "timed" else None,
            "revision": self.revision,
            "bins": [{"id": index + 1, "count": count, "capacity": QUOTA, "progress": count} for index, count in enumerate(self.counts)],
            "world": WorldGenerator().generate(self),
        }


class WorldService(SessionService):
    """The v2 schema uses its own signing salt; old saved files stay independent."""

    def __init__(self, secret, clock=time.time):
        super().__init__(secret, clock)
        self.serializer = URLSafeTimedSerializer(secret, salt="mdr-world-v2")

    def decode(self, token):
        if not isinstance(token, str) or not token or len(token) > 8192:
            raise InvalidSession("Provide a valid world save token.")
        try:
            payload = self.serializer.loads(token, max_age=TOKEN_MAX_AGE)
        except SignatureExpired as error:
            raise ExpiredSession("This file has expired. Open a new assignment.") from error
        except BadData as error:
            raise InvalidSession("This world save could not be verified.") from error
        session = WorldSession.from_payload(payload)
        if session.started_at > self.clock() + 60:
            raise InvalidSession("World start time is in the future.")
        session.refresh(self.clock())
        return session
