"""Each domain method has direct tests, including adversarial token handling."""

import copy

import pytest

from mdr.engine import (
    BoardGenerator, ExpiredSession, GameSession, InvalidSession, MODES,
    SessionService, TOKEN_MAX_AGE, TOKEN_MAX_LENGTH,
)


@pytest.fixture
def session():
    return GameSession("a" * 32, "Cold Harbor", "standard", 42, 1000.0)


@pytest.fixture
def service():
    return SessionService("a-test-secret-with-at-least-32-characters", clock=lambda: 1010.0)


def test_board_generator_generate_is_deterministic_and_round_specific():
    generator = BoardGenerator()
    assert generator.generate(42, 0, []) == generator.generate(42, 0, [])
    assert generator.generate(42, 0, []) != generator.generate(42, 1, [])
    assert generator.generate(42, 0, []) != generator.generate(43, 0, [])


@pytest.mark.parametrize("seed", [0, 1, 42, 999, 2**32 - 1])
@pytest.mark.parametrize("round_index", range(4))
def test_board_generator_generate_has_legal_disjoint_clusters(seed, round_index):
    board = BoardGenerator().generate(seed, round_index, [2])
    assert (board["columns"], board["rows"]) == (20, 10)
    assert [cell["id"] for cell in board["cells"]] == list(range(200))
    assert all(0 <= cell["value"] <= 9 for cell in board["cells"])
    all_cells = []
    for bin_id, cluster in enumerate(board["clusters"], 1):
        first = cluster["cells"][0]
        assert cluster["cells"] == [first, first + 1, first + 20, first + 21]
        assert first % 20 < 19 and 0 <= first < 180
        assert cluster["bin"] == bin_id
        assert cluster["temper"] in {"WO", "FC", "DR", "MA"}
        assert cluster["collected"] is (bin_id == 2)
        all_cells.extend(cluster["cells"])
    assert len(set(all_cells)) == 20


def test_game_session_new_has_defaults_unique_identity_and_trimmed_filename():
    first = GameSession.new(now=1000)
    second = GameSession.new("orientation", "  Siena  ", now=1000)
    assert first.id != second.id
    assert first.mode == "standard" and first.file == "Cold Harbor"
    assert first.started_at == 1000 and 0 <= first.seed < 2**32
    assert second.file == "Siena" and second.mode == "orientation"
    assert GameSession.new().started_at > 0


@pytest.mark.parametrize("mode", [None, "unknown", [], True])
def test_game_session_new_rejects_invalid_mode(mode):
    with pytest.raises(ValueError, match="mode"):
        GameSession.new(mode)


@pytest.mark.parametrize("filename", [None, "", "   ", "x" * 49, "Cold\nHarbor", "a\x00b"])
def test_game_session_new_rejects_invalid_filename(filename):
    with pytest.raises(ValueError, match="File names"):
        GameSession.new(file=filename)


def test_game_session_to_payload_is_compact_and_copies_collected_list(session):
    payload = session.to_payload()
    assert payload["v"] == 1 and payload["seed"] == 42
    assert "board" not in payload
    payload["collected"].append(1)
    assert session.collected == []


def test_game_session_from_payload_round_trips(session):
    assert GameSession.from_payload(session.to_payload()) == session


@pytest.mark.parametrize("key,value", [
    ("v", 2), ("v", True), ("id", "not-a-session"), ("id", None),
    ("mode", "unknown"), ("mode", []), ("file", "  "), ("file", " padded"),
    ("file", "a\nb"), ("file", None), ("seed", -1), ("seed", True),
    ("seed", 2**32), ("round_index", 4), ("score", -1), ("score", 6751),
    ("streak", 1), ("mistakes", 6), ("mistakes", 5), ("collected", [1, 1]),
    ("collected", [0]), ("collected", [True]), ("collected", "1"),
    ("collected", [1, 2, 3, 4, 5]), ("started_at", -1),
    ("started_at", float("nan")), ("started_at", float("inf")),
    ("started_at", True), ("finished_at", 999), ("finished_at", 1001),
    ("finished_at", "later"), ("status", "unknown"), ("status", "completed"),
    ("status", "failed"),
])
def test_game_session_from_payload_rejects_corrupt_state(session, key, value):
    payload = session.to_payload()
    payload[key] = value
    with pytest.raises(InvalidSession):
        GameSession.from_payload(payload)


@pytest.mark.parametrize("payload", [None, [], {}, {"v": 1}])
def test_game_session_from_payload_rejects_invalid_shape(payload):
    with pytest.raises(InvalidSession):
        GameSession.from_payload(payload)


def test_game_session_from_payload_rejects_extra_keys_and_inconsistent_completion(session):
    payload = session.to_payload()
    payload["admin"] = True
    with pytest.raises(InvalidSession):
        GameSession.from_payload(payload)
    payload = session.to_payload()
    payload.update(round_index=3, collected=[1, 2, 3, 4, 5])
    with pytest.raises(InvalidSession, match="completion"):
        GameSession.from_payload(payload)


def test_game_session_refresh_expires_at_deadline_and_freezes_elapsed(session):
    session.refresh(1899.9)
    assert session.status == "active"
    session.refresh(1900)
    assert session.status == "failed" and session.finished_at == 1900
    session.refresh(9000)
    assert session.finished_at == 1900


def test_game_session_refresh_orientation_never_expires(session):
    session.mode = "orientation"
    session.refresh(100_000)
    assert session.status == "active"


def test_game_session_refine_accepts_unordered_exact_cluster_and_builds_streak(session):
    clusters = session.to_public(1000)["board"]["clusters"]
    assert session.refine(list(reversed(clusters[0]["cells"])), 1, 1001)["accepted"]
    assert session.score == 100 and session.streak == 1
    assert session.refine(clusters[1]["cells"], 2, 1002)["accepted"]
    assert session.score == 225 and session.streak == 2
    assert session.to_public(1002)["progress"] == 10


def test_game_session_refine_collected_cluster_is_harmless_duplicate(session):
    cells = session.to_public(1000)["board"]["clusters"][0]["cells"]
    session.refine(cells, 1, 1001)
    snapshot = copy.deepcopy(session.to_payload())
    result = session.refine(cells, 1, 1002)
    assert not result["accepted"] and "already" in result["message"]
    assert session.to_payload() == snapshot


def test_game_session_refine_wrong_bin_and_partial_selection_cost_strikes(session):
    clusters = session.to_public(1000)["board"]["clusters"]
    session.refine(clusters[0]["cells"], 1, 1001)
    assert not session.refine(clusters[1]["cells"], 3, 1002)["accepted"]
    assert (session.score, session.streak, session.mistakes) == (50, 0, 1)
    session.refine(clusters[1]["cells"][:3], 2, 1003)
    assert (session.score, session.mistakes) == (0, 2)


@pytest.mark.parametrize("mode", MODES)
def test_game_session_refine_reaches_mode_strike_limit(session, mode):
    session.mode = mode
    for _ in range(MODES[mode]["strikes"]):
        assert not session.refine([], 1, 1001)["accepted"]
    assert session.status == "failed" and session.finished_at == 1001
    payload = session.to_payload()
    assert not session.refine([], 1, 1002)["accepted"]
    assert session.to_payload() == payload
    assert GameSession.from_payload(payload) == session


def test_game_session_refine_after_deadline_does_not_score(session):
    cluster = session.to_public(1000)["board"]["clusters"][0]
    assert not session.refine(cluster["cells"], 1, 1900)["accepted"]
    assert session.status == "failed" and session.score == 0


def test_game_session_refine_completes_twenty_batches_and_advances_boards(session):
    first_board = session.to_public(1000)["board"]
    for round_number in range(1, 5):
        state = session.to_public(1000)
        assert state["round"] == round_number
        for cluster in state["board"]["clusters"]:
            assert session.refine(cluster["cells"], cluster["bin"], 1001)["accepted"]
        if round_number == 1:
            assert session.to_public(1001)["board"] != first_board
            assert all(bin_["progress"] == 25 for bin_ in session.to_public(1001)["bins"])
    final = session.to_public(2000)
    assert final["status"] == "completed" and final["progress"] == 100
    assert final["round"] == 4 and final["score"] == 6750 and final["streak"] == 20
    assert final["elapsed_seconds"] == 1
    assert all(bin_["count"] == 4 and bin_["progress"] == 100 for bin_ in final["bins"])
    assert GameSession.from_payload(session.to_payload()) == session


@pytest.mark.parametrize("cells,bin_id", [
    (None, 1), ("1", 1), ([1, 1], 1), ([True], 1), ([-1], 1), ([200], 1),
    ([1.0], 1), (list(range(201)), 1), ([], 0), ([], 6), ([], True), ([], "1"),
])
def test_game_session_refine_rejects_malformed_input_without_mutation(session, cells, bin_id):
    snapshot = session.to_payload()
    with pytest.raises(ValueError):
        session.refine(cells, bin_id, 1001)
    assert session.to_payload() == snapshot


def test_game_session_to_public_hides_seed_and_clamps_backwards_clock(session):
    state = session.to_public(999)
    assert "seed" not in state and "started_at" not in state
    assert state["elapsed_seconds"] == 0 and state["remaining_seconds"] == 900
    assert state["max_mistakes"] == 5 and state["rounds"] == 4
    session.mode = "orientation"
    assert session.to_public(1500)["remaining_seconds"] is None


@pytest.mark.parametrize("secret", [None, "short", "x" * 31])
def test_session_service_init_rejects_short_secret(secret):
    with pytest.raises(ValueError, match="32"):
        SessionService(secret)


def test_session_service_init_uses_injected_clock(service):
    assert service.clock() == 1010


def test_session_service_encode_returns_signed_state_and_refreshes_expiration(session):
    service = SessionService("a-test-secret-with-at-least-32-characters", clock=lambda: 1900)
    result = service.encode(session)
    assert set(result) == {"token", "state"}
    assert result["state"]["status"] == "failed"
    assert service.serializer.loads(result["token"])["status"] == "failed"


def test_session_service_decode_round_trips_signed_session(service, session):
    token = service.encode(session)["token"]
    assert service.decode(token) == session
    assert len(token) < 1024


@pytest.mark.parametrize("token", [None, "", [], "forged", "x" * (TOKEN_MAX_LENGTH + 1)])
def test_session_service_decode_rejects_bad_tokens(service, token):
    with pytest.raises(InvalidSession):
        service.decode(token)


def test_session_service_decode_rejects_modified_signature_and_other_secret(service, session):
    token = service.encode(session)["token"]
    with pytest.raises(InvalidSession):
        service.decode(token[:-8] + "tampered")
    other = SessionService("another-secret-with-at-least-32-characters", clock=lambda: 1010)
    with pytest.raises(InvalidSession):
        other.decode(token)


def test_session_service_decode_rejects_signed_invalid_payload_and_future_start(service, session):
    with pytest.raises(InvalidSession):
        service.decode(service.serializer.dumps({"mode": "standard"}))
    session.started_at = 2000
    with pytest.raises(InvalidSession, match="start time"):
        service.decode(service.encode(session)["token"])


def test_session_service_decode_distinguishes_expired_signature(service, session, monkeypatch):
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000)
    token = service.encode(session)["token"]
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000 + TOKEN_MAX_AGE + 1)
    with pytest.raises(ExpiredSession):
        service.decode(token)


def test_session_service_decode_refreshes_an_elapsed_game(service, session):
    token = service.encode(session)["token"]
    service.clock = lambda: 1900
    assert service.decode(token).status == "failed"
