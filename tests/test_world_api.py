"""Version-two HTTP contracts, independent modes, and signed capture workflows."""

import pytest

from app import create_app
from mdr.engine import TOKEN_MAX_AGE
from mdr.world import DIFFICULTIES, MODES


@pytest.fixture
def world_app():
    return create_app({"TESTING": True, "MDR_PRODUCTION": False, "MDR_SECRET_KEY": "a-test-secret-with-at-least-32-characters"}, clock=lambda: 1000.0)


@pytest.fixture
def world_client(world_app):
    return world_app.test_client()


def test_world_action_dispatches_create_restore_capture_and_mistake(world_client):
    created = world_client.post("/api/v2/session", json={})
    assert created.status_code == 200
    body = created.get_json()
    assert body["state"]["mode"] == "quota" and body["state"]["difficulty"] == "normal"
    assert body["state"]["file"] == "Cold Harbor"
    restored = world_client.post("/api/v2/restore", json={"token": body["token"]})
    assert restored.status_code == 200 and restored.get_json()["state"] == body["state"]
    cluster = body["state"]["world"]["clusters"][0]
    captured = world_client.post("/api/v2/capture", json={"token": body["token"], "cluster_id": cluster["id"]})
    assert captured.status_code == 200
    captured = captured.get_json()
    assert captured["feedback"]["accepted"] and captured["state"]["score"] == cluster["points"]
    assert captured["feedback"]["bin"] == cluster["bin"]
    assert captured["state"]["refined_digits"] == len(cluster["cells"])
    assert captured["state"]["world"]["clusters"][0]["id"] != cluster["id"]
    mistaken = world_client.post("/api/v2/mistake", json={"token": captured["token"], "cell": 0})
    assert mistaken.status_code == 200
    assert mistaken.get_json()["feedback"]["points"] == 0
    assert mistaken.get_json()["state"]["score"] == captured["state"]["score"]


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("difficulty", DIFFICULTIES)
def test_world_api_exposes_all_nine_mode_difficulty_combinations(world_client, mode, difficulty):
    response = world_client.post("/api/v2/session", json={"mode": mode, "difficulty": difficulty, "file": "Siena"})
    assert response.status_code == 200
    state = response.get_json()["state"]
    assert state["mode"] == mode and state["difficulty"] == difficulty and state["file"] == "Siena"
    assert state["remaining_seconds"] == (900 if mode == "timed" else None)
    assert state["max_mistakes"] == (3 if difficulty == "quarter_refiner" else None)
    assert state["world"]["columns"] == 256 and state["world"]["rows"] == 160
    assert len(state["world"]["clusters"]) == 80 and len(state["bins"]) == 5


@pytest.mark.parametrize("action", ["session", "restore", "capture", "mistake"])
def test_world_api_requires_post_and_secures_all_responses(world_client, action):
    response = world_client.get(f"/api/v2/{action}")
    assert response.status_code == 405 and response.headers["Allow"] == "POST"
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


@pytest.mark.parametrize("path,body", [
    ("session", None), ("session", []), ("session", {"unknown": 1}),
    ("session", {"difficulty": "bad"}), ("session", {"mode": []}),
    ("restore", {}), ("restore", {"token": "bad", "score": 999}),
    ("capture", {"token": "bad"}), ("capture", {"token": "bad", "cluster_id": "0:0", "points": 1000}),
    ("mistake", {"token": "bad"}), ("mistake", {"token": "bad", "cell": 0, "difficulty": "normal"}),
])
def test_world_api_rejects_missing_unknown_and_invalid_fields(world_client, path, body):
    response = world_client.post(f"/api/v2/{path}", json=body)
    assert response.status_code == 400 and isinstance(response.get_json()["error"], str)


def test_world_api_unknown_action_returns_404(world_client):
    assert world_client.post("/api/v2/supervisor", json={}).status_code == 404


@pytest.mark.parametrize("token", [None, 0, [], "forged", "x" * 8193])
def test_world_api_rejects_invalid_signed_tokens(world_client, token):
    response = world_client.post("/api/v2/restore", json={"token": token})
    assert response.status_code == 400 and "error" in response.get_json()


def test_world_api_validates_capture_identifiers_and_mistake_cells(world_client):
    token = world_client.post("/api/v2/session", json={}).get_json()["token"]
    for cluster in (None, [], "bad", "0:1:2"):
        assert world_client.post("/api/v2/capture", json={"token": token, "cluster_id": cluster}).status_code == 400
    for cell in (None, True, -1, 40960, "0"):
        assert world_client.post("/api/v2/mistake", json={"token": token, "cell": cell}).status_code == 400


def test_world_api_stale_capture_cannot_collect_new_generation_or_double_score(world_client):
    first = world_client.post("/api/v2/session", json={}).get_json()
    captured = world_client.post("/api/v2/capture", json={"token": first["token"], "cluster_id": "0:0"}).get_json()
    stale = world_client.post("/api/v2/capture", json={"token": captured["token"], "cluster_id": "0:0"}).get_json()
    assert not stale["feedback"]["accepted"] and stale["state"] == captured["state"]
    restored = world_client.post("/api/v2/restore", json={"token": stale["token"]}).get_json()
    assert restored["state"] == captured["state"]
    # Signed saves are independent histories; an old token does not aggregate rewards.
    original = world_client.post("/api/v2/restore", json={"token": first["token"]}).get_json()
    assert original["state"]["score"] == 0


@pytest.mark.parametrize("difficulty", DIFFICULTIES)
def test_world_api_applies_each_penalty_and_preserves_it_on_restore(world_client, difficulty):
    body = world_client.post("/api/v2/session", json={"difficulty": difficulty}).get_json()
    body = world_client.post("/api/v2/capture", json={"token": body["token"], "cluster_id": "0:0"}).get_json()
    score = body["state"]["score"]
    for _ in range(3):
        body = world_client.post("/api/v2/mistake", json={"token": body["token"], "cell": 0}).get_json()
    assert body["state"]["score"] == (max(0, score - 150) if difficulty == "quota_achiever" else score)
    assert body["state"]["status"] == ("failed" if difficulty == "quarter_refiner" else "active")
    restored = world_client.post("/api/v2/restore", json={"token": body["token"]}).get_json()
    assert restored["state"] == body["state"]


def test_world_api_restoration_expires_timed_shift_at_exact_deadline(world_client, world_app):
    body = world_client.post("/api/v2/session", json={"mode": "timed"}).get_json()
    world_app.extensions["world_service"].clock = lambda: 1900
    restored = world_client.post("/api/v2/restore", json={"token": body["token"]}).get_json()
    assert restored["state"]["status"] == "failed" and restored["state"]["remaining_seconds"] == 0


def test_world_api_signature_expiration_returns_410(world_client, monkeypatch):
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000)
    token = world_client.post("/api/v2/session", json={}).get_json()["token"]
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000 + TOKEN_MAX_AGE + 1)
    response = world_client.post("/api/v2/restore", json={"token": token})
    assert response.status_code == 410 and "expired" in response.get_json()["error"]


def test_world_api_legacy_and_world_tokens_cannot_cross_protocols(world_client):
    legacy = world_client.post("/api/session", json={}).get_json()["token"]
    world = world_client.post("/api/v2/session", json={}).get_json()["token"]
    assert world_client.post("/api/v2/restore", json={"token": legacy}).status_code == 400
    assert world_client.post("/api/restore", json={"token": world}).status_code == 400
    assert world_client.post("/api/restore", json={"token": legacy}).status_code == 200


def test_world_api_missing_production_secret_returns_503():
    app = create_app({"TESTING": True, "MDR_PRODUCTION": True, "MDR_SECRET_KEY": None})
    assert app.test_client().post("/api/v2/session", json={}).status_code == 503
