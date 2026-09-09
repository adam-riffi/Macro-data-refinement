"""Behavioral and adversarial tests for every authored world domain method."""

import copy

import pytest

from mdr.engine import ExpiredSession, GameSession, InvalidSession, SessionService, TOKEN_MAX_AGE
from mdr.world import COLUMNS, DIFFICULTIES, MODES, QUOTA, ROWS, SLOTS, WorldGenerator, WorldService, WorldSession


@pytest.fixture
def world():
    return WorldSession("a" * 32, "Cold Harbor", "quota", "normal", 42, 1000.0)


@pytest.fixture
def world_service():
    return WorldService("a-test-secret-with-at-least-32-characters", clock=lambda: 1010.0)


def test_world_generator_cluster_is_deterministic_connected_and_varied():
    generator = WorldGenerator()
    cluster = generator.cluster(42, 0, 0)
    assert cluster == generator.cluster(42, 0, 0)
    assert cluster != generator.cluster(43, 0, 0)
    assert cluster != generator.cluster(42, 0, 1)
    sizes, shapes, point_totals = set(), set(), set()
    for slot in range(SLOTS):
        cluster = generator.cluster(42, slot, 0)
        cells = set(cluster["cells"])
        assert 3 <= len(cells) <= 18
        assert len(cells) * 10 <= cluster["points"] <= len(cells) * 10 + 9
        assert cluster["bin"] == slot % 5 + 1
        assert cluster["id"] == f"{slot}:0"
        assert cluster["temper"] in {"WO", "FC", "DR", "MA"}
        assert cluster["active"] is True
        coordinates = {(cell % COLUMNS, cell // COLUMNS) for cell in cells}
        pending = [next(iter(coordinates))]
        reached = set(pending)
        while pending:
            x, y = pending.pop()
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    neighbor = (x + dx, y + dy)
                    if neighbor in coordinates and neighbor not in reached:
                        reached.add(neighbor)
                        pending.append(neighbor)
        assert reached == coordinates
        min_x, min_y = min(x for x, _ in coordinates), min(y for _, y in coordinates)
        shapes.add(tuple(sorted((x - min_x, y - min_y) for x, y in coordinates)))
        sizes.add(len(cells))
        point_totals.add(cluster["points"])
    assert len(sizes) >= 12 and len(shapes) >= 60 and len(point_totals) >= 35
    assert generator.cluster(42, 0, 0, active=False)["active"] is False


@pytest.mark.parametrize("seed", [0, 1, 42, 2**32 - 1])
@pytest.mark.parametrize("generation", [0, 1, 2, 999999999])
def test_world_generator_regions_never_overlap_or_leave_the_world(seed, generation):
    generator = WorldGenerator()
    seen = set()
    for slot in range(SLOTS):
        cells = set(generator.cluster(seed, slot, generation)["cells"])
        assert not (cells & seen)
        assert all(0 <= cell < COLUMNS * ROWS for cell in cells)
        assert not cells.intersection(generator.cluster(seed, slot, generation + 1)["cells"])
        seen.update(cells)


def test_world_generator_generate_marks_completed_bins_and_closed_worlds_inactive(world):
    generator = WorldGenerator()
    original = generator.generate(world)
    assert (original["columns"], original["rows"], original["seed"]) == (256, 160, 42)
    assert len(original["clusters"]) == SLOTS
    assert all(cluster["active"] for cluster in original["clusters"])
    assert original == generator.generate(world)
    world.counts[0] = QUOTA
    assert all(cluster["active"] is (cluster["bin"] != 1) for cluster in generator.generate(world)["clusters"])
    world.status = "failed"
    assert not any(cluster["active"] for cluster in generator.generate(world)["clusters"])


def test_world_session_new_has_unique_identity_independent_settings_and_trimmed_filename():
    first = WorldSession.new(now=1000)
    second = WorldSession.new("endless", "quarter_refiner", "  Siena  ", now=1000)
    assert first.id != second.id
    assert (first.mode, first.difficulty, first.file) == ("quota", "normal", "Cold Harbor")
    assert first.started_at == 1000 and 0 <= first.seed < 2**32
    assert (second.mode, second.difficulty, second.file) == ("endless", "quarter_refiner", "Siena")
    assert len(first.generations) == SLOTS and first.counts == [0] * 5
    first.generations[0] = 1
    assert second.generations[0] == 0
    assert WorldSession.new().started_at > 0


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("difficulty", DIFFICULTIES)
def test_world_session_nine_independent_mode_difficulty_combinations(mode, difficulty):
    session = WorldSession.new(mode, difficulty, now=1000)
    state = session.to_public(1001)
    assert state["mode"] == mode and state["difficulty"] == difficulty
    assert state["remaining_seconds"] == (899 if mode == "timed" else None)
    assert state["max_mistakes"] == (3 if difficulty == "quarter_refiner" else None)
    assert WorldSession.from_payload(session.to_payload()) == session


@pytest.mark.parametrize("settings", [(None, "normal"), ([], "normal"), ("unknown", "normal"), ("quota", None), ("quota", []), ("quota", "unknown")])
def test_world_session_new_rejects_unsupported_settings(settings):
    with pytest.raises(ValueError, match="mode and difficulty"):
        WorldSession.new(*settings)


@pytest.mark.parametrize("filename", [None, "", "   ", "x" * 49, "a\nb", "a\x00b"])
def test_world_session_new_rejects_invalid_filenames(filename):
    with pytest.raises(ValueError, match="File names"):
        WorldSession.new(file=filename)


def test_world_session_to_payload_copies_bounded_counters_and_omits_rendered_world(world):
    payload = world.to_payload()
    assert payload["v"] == 2 and payload["seed"] == 42
    assert "world" not in payload and "clusters" not in payload
    assert len(payload["generations"]) == SLOTS and len(payload["counts"]) == 5
    payload["generations"][0] = 9
    payload["counts"][0] = 99
    assert world.generations[0] == world.counts[0] == 0


def test_world_session_from_payload_round_trips_active_captured_and_closed_runs(world):
    assert WorldSession.from_payload(world.to_payload()) == world
    world.capture("0:0", 1001)
    assert WorldSession.from_payload(world.to_payload()) == world
    world.difficulty = "quarter_refiner"
    for _ in range(3):
        world.mistake(0, 1002)
    assert WorldSession.from_payload(world.to_payload()) == world


@pytest.mark.parametrize("payload", [None, [], {}, {"v": 2}])
def test_world_session_from_payload_rejects_invalid_shape(payload):
    with pytest.raises(InvalidSession, match="save format"):
        WorldSession.from_payload(payload)


@pytest.mark.parametrize("key,value", [
    ("v", True), ("v", 1), ("extra", 1), ("id", None), ("id", "invalid"),
    ("mode", []), ("mode", "standard"), ("difficulty", []), ("difficulty", "unknown"),
    ("file", None), ("file", "a\nb"), ("file", " padded"), ("file", ""), ("file", "x" * 49),
    ("seed", True), ("seed", -1), ("seed", 2**32), ("score", -1), ("score", 10**14 + 1),
    ("refined_digits", True), ("refined_digits", 10**13 + 1), ("captured_clusters", -1),
    ("mistakes", 4), ("cycle", 0), ("revision", 10**13 + 1),
    ("generations", {}), ("generations", []), ("generations", [True] * SLOTS),
    ("generations", [-1] * SLOTS), ("generations", [10**9 + 1] * SLOTS),
    ("counts", {}), ("counts", [0] * 4), ("counts", [101] * 5),
    ("captured_clusters", 1), ("refined_digits", 1), ("score", 1), ("mistakes", 1),
    ("started_at", True), ("started_at", -1), ("started_at", float("nan")),
    ("started_at", float("inf")), ("finished_at", True), ("finished_at", float("nan")),
    ("finished_at", 999), ("finished_at", 1001), ("status", "unknown"),
    ("status", "failed"), ("status", "completed"),
])
def test_world_session_from_payload_rejects_corrupt_fields(world, key, value):
    payload = world.to_payload()
    payload[key] = value
    with pytest.raises(InvalidSession):
        WorldSession.from_payload(payload)


def test_world_session_from_payload_rejects_inconsistent_totals_and_completion(world):
    world.capture("0:0", 1001)
    for updates in [
        {"revision": 0}, {"refined_digits": 2}, {"refined_digits": 19}, {"score": 190},
        {"counts": [100] * 5},
        {"difficulty": "quarter_refiner", "mistakes": 3},
        {"mode": "endless", "counts": [100] * 5},
        {"status": "completed", "finished_at": 1002},
    ]:
        payload = world.to_payload()
        payload.update(updates)
        with pytest.raises(InvalidSession):
            WorldSession.from_payload(payload)


def test_world_session_refresh_expires_timed_runs_at_exact_deadline_and_freezes_finish(world):
    world.mode = "timed"
    world.refresh(1899.99)
    assert world.status == "active"
    world.refresh(1900)
    assert (world.status, world.finished_at) == ("failed", 1900)
    world.refresh(4000)
    assert world.finished_at == 1900
    for mode in ("quota", "endless"):
        untimed = WorldSession.new(mode, now=1000)
        untimed.refresh(1_000_000)
        assert untimed.status == "active"


def test_world_session_capture_scores_variable_cluster_and_replaces_it_in_another_zone(world):
    original = WorldGenerator().cluster(world.seed, 0, 0)
    result = world.capture(original["id"], 1001)
    assert result["accepted"] is True and result["cells"] == original["cells"]
    assert result["points"] == world.score == original["points"]
    assert result["bin"] == original["bin"] and result["replacement_generation"] == 1
    assert world.counts[0] == world.refined_digits == len(original["cells"])
    assert world.revision == world.captured_clusters == world.generations[0] == 1
    replacement = WorldGenerator().generate(world)["clusters"][0]
    assert replacement["id"] == "0:1" and replacement["active"]
    assert not set(original["cells"]).intersection(replacement["cells"])


@pytest.mark.parametrize("cluster_id", [None, [], 0, "", "bad", "-1:0", "100:0", "0:12345678901", "0:1:2"])
def test_world_session_capture_rejects_malformed_identifiers_without_mutation(world, cluster_id):
    snapshot = world.to_payload()
    with pytest.raises(ValueError, match="cluster identifier"):
        world.capture(cluster_id, 1001)
    assert world.to_payload() == snapshot


def test_world_session_capture_stale_missing_and_full_bin_clusters_do_not_change_progress(world):
    world.capture("0:0", 1001)
    snapshot = world.to_payload()
    for cluster_id in ("0:0", "1:999", "80:0", "99:0"):
        assert world.capture(cluster_id, 1002) == {
            "accepted": False, "message": "This group is no longer available.", "points": 0, "bin": None, "cells": [],
        }
        assert world.to_payload() == snapshot
    world.counts[0] = QUOTA
    snapshot = world.to_payload()
    assert not world.capture("0:1", 1002)["accepted"]
    assert world.to_payload() == snapshot


def test_world_session_capture_cannot_score_at_or_after_timed_deadline(world):
    world.mode = "timed"
    assert not world.capture("0:0", 1900)["accepted"]
    assert world.score == 0 and world.status == "failed" and world.finished_at == 1900
    assert not world.capture("0:0", 2000)["accepted"]


@pytest.mark.parametrize("mode", MODES)
def test_world_session_capture_completes_quota_or_advances_endless_cycle(world, mode):
    world.mode = mode
    first_generation = copy.deepcopy(world.generations)
    for slot in range(5):
        while world.counts[slot] < QUOTA:
            result = world.capture(f"{slot}:{world.generations[slot]}", 1001)
            assert result["accepted"]
            assert world.counts[slot] <= QUOTA
            if world.cycle == 2:
                break
    assert world.generations != first_generation
    assert world.refined_digits >= 500
    assert WorldSession.from_payload(world.to_payload()) == world
    if mode == "endless":
        assert world.status == "active" and world.cycle == 2 and world.counts == [0] * 5
        assert all(cluster["active"] for cluster in WorldGenerator().generate(world)["clusters"])
        assert world.capture(f"0:{world.generations[0]}", 1002)["accepted"]
    else:
        assert world.status == "completed" and world.finished_at == 1001
        assert world.counts == [100] * 5 and world.to_public(9000)["progress"] == 100
        assert not world.capture("6:0", 1002)["accepted"]


def test_world_session_capture_clamps_backwards_finish_timestamp(world):
    world.counts = [99] + [100] * 4
    assert world.capture("0:0", 900)["accepted"]
    assert world.finished_at == world.started_at


def test_world_session_mistake_applies_difficulty_without_penalizing_gathering(world):
    cluster_cell = WorldGenerator().cluster(world.seed, 0, 0)["cells"][0]
    before = world.to_payload()
    assert not world.mistake(cluster_cell, 1001)["accepted"]
    assert world.to_payload() == before
    feedback = world.mistake(0, 1001)
    assert feedback["points"] == 0 and world.mistakes == 0 and world.revision == 1
    world.difficulty = "quota_achiever"
    assert world.mistake(0, 1001)["points"] == 0
    world.score = 20
    assert world.mistake(0, 1001)["points"] == -20 and world.score == 0
    world.score = 100
    assert world.mistake(0, 1001)["points"] == -50 and world.score == 50
    assert world.mistakes == 0


@pytest.mark.parametrize("cell", [None, "0", True, -1, 40960, 1.5, []])
def test_world_session_mistake_rejects_invalid_cells_without_mutation(world, cell):
    before = world.to_payload()
    with pytest.raises(ValueError, match="cell"):
        world.mistake(cell, 1001)
    assert world.to_payload() == before


def test_world_session_mistake_third_strike_ends_run_and_further_clicks_are_harmless(world):
    world.difficulty = "quarter_refiner"
    for count in range(1, 4):
        world.mistake(0, 900)
        assert world.mistakes == count
        assert world.status == ("failed" if count == 3 else "active")
    assert world.finished_at == 1000
    snapshot = world.to_payload()
    world.mistake(0, 1002)
    assert world.to_payload() == snapshot


def test_world_session_to_public_exposes_quota_camera_world_and_freezes_elapsed_time(world):
    public = world.to_public(999)
    assert public["elapsed_seconds"] == 0 and public["remaining_seconds"] is None
    assert "started_at" not in public and "generations" not in public
    assert public["progress"] == 0 and public["cycle"] == 1
    assert public["world"]["columns"] * public["world"]["rows"] == 40960
    assert public["bins"] == [{"id": index + 1, "count": 0, "capacity": 100, "progress": 0} for index in range(5)]
    world.capture("0:0", 1001)
    assert world.to_public(1002)["progress"] == world.counts[0] / 5
    world.mode = "timed"
    public = world.to_public(3000)
    assert public["status"] == "failed" and public["elapsed_seconds"] == 900
    assert public["remaining_seconds"] == 0
    assert not any(cluster["active"] for cluster in public["world"]["clusters"])


def test_world_service_init_uses_distinct_signing_salt_and_injected_clock(world_service, world):
    assert world_service.clock() == 1010
    assert world_service.serializer.salt == b"mdr-world-v2"
    old = SessionService("a-test-secret-with-at-least-32-characters", clock=lambda: 1010)
    token = world_service.encode(world)["token"]
    with pytest.raises(InvalidSession):
        old.decode(token)
    old_token = old.encode(GameSession.new(now=1000))["token"]
    with pytest.raises(InvalidSession):
        world_service.decode(old_token)
    with pytest.raises(ValueError):
        WorldService("short")


def test_world_service_decode_round_trips_signed_bounded_state(world_service, world):
    envelope = world_service.encode(world)
    assert set(envelope) == {"token", "state"}
    assert world_service.decode(envelope["token"]) == world
    assert len(envelope["token"]) < 8192
    # Even a very long endless history remains eighty counters, never a capture log.
    world.mode = "endless"
    world.generations = [999999999] * SLOTS
    world.captured_clusters = sum(world.generations)
    world.refined_digits = world.captured_clusters * 10
    world.score = world.captured_clusters * 100
    world.revision = world.captured_clusters
    large = world_service.encode(world)["token"]
    assert len(large) < 8192 and world_service.decode(large) == world


@pytest.mark.parametrize("token", [None, [], 1, "", "forged", "x" * 8193])
def test_world_service_decode_rejects_invalid_or_oversized_tokens(world_service, token):
    with pytest.raises(InvalidSession):
        world_service.decode(token)


def test_world_service_decode_rejects_tampered_wrong_secret_invalid_payload_and_future_start(world_service, world):
    token = world_service.encode(world)["token"]
    with pytest.raises(InvalidSession):
        world_service.decode(token[:-8] + "tampered")
    other = WorldService("another-secret-with-at-least-32-characters", clock=lambda: 1010)
    with pytest.raises(InvalidSession):
        other.decode(token)
    with pytest.raises(InvalidSession):
        world_service.decode(world_service.serializer.dumps({"v": 2}))
    world.started_at = 2000
    with pytest.raises(InvalidSession, match="future"):
        world_service.decode(world_service.encode(world)["token"])


def test_world_service_decode_distinguishes_signature_expiry(world_service, world, monkeypatch):
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000)
    token = world_service.encode(world)["token"]
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000 + TOKEN_MAX_AGE + 1)
    with pytest.raises(ExpiredSession, match="expired"):
        world_service.decode(token)


def test_world_service_decode_refreshes_expired_timed_world(world_service, world):
    world.mode = "timed"
    token = world_service.encode(world)["token"]
    world_service.clock = lambda: 1900
    restored = world_service.decode(token)
    assert restored.status == "failed" and restored.finished_at == 1900
