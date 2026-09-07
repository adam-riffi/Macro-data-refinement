"""API tests exercise every route, app hook, input parser, and error handler."""

import pytest
from jinja2 import DictLoader

from app import LOCAL_SECRET, create_app
from mdr.engine import TOKEN_MAX_AGE


@pytest.fixture
def app():
    application = create_app({"TESTING": True, "MDR_PRODUCTION": False, "MDR_SECRET_KEY": "a-test-secret-with-at-least-32-characters"}, clock=lambda: 1000.0)
    application.jinja_loader = DictLoader({"index.html": "<!doctype html><title>Macrodata Refinement</title>"})
    return application


@pytest.fixture
def client(app):
    return app.test_client()


def test_create_app_uses_stable_development_secret(monkeypatch):
    monkeypatch.delenv("MDR_SECRET_KEY", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("MDR_ENV", raising=False)
    first = create_app().test_client()
    second = create_app().test_client()
    session = first.post("/api/session", json={}).get_json()
    restored = second.post("/api/restore", json={"token": session["token"]})
    assert restored.status_code == 200
    assert restored.get_json()["state"]["id"] == session["state"]["id"]


@pytest.mark.parametrize("secret", [None, "short", "x" * 48, LOCAL_SECRET])
def test_create_app_fails_closed_for_missing_or_weak_production_secret(secret):
    application = create_app({"TESTING": True, "MDR_PRODUCTION": True, "MDR_SECRET_KEY": secret})
    application.jinja_loader = DictLoader({"index.html": "The department is preparing."})
    client = application.test_client()
    assert client.get("/").status_code == 200
    assert client.get("/api/health").status_code == 503
    assert client.post("/api/session", json={}).status_code == 503


def test_create_app_detects_vercel_and_production_environment(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("MDR_SECRET_KEY", raising=False)
    assert create_app().config["MDR_PRODUCTION"]
    monkeypatch.delenv("VERCEL")
    monkeypatch.setenv("MDR_ENV", "production")
    assert create_app().config["MDR_PRODUCTION"]


def test_index_renders_the_terminal(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"Macrodata Refinement" in response.data
    assert response.content_type.startswith("text/html")


def test_health_returns_minimal_readiness_json(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "version": "1.0.0"}


@pytest.mark.parametrize("path", ["/.env", "/.git/config", "/.private/architecture.md", "/assets/.hidden", "/../app.py", "/%2e%2e/app.py", "/private-docs/index.md", "/docs/private/architecture.drawio", "/app.py", "/mdr/engine.py", "/requirements.txt", "/tests/test_engine.py"])
def test_check_request_and_static_routing_protect_private_paths(client, path):
    assert client.get(path).status_code == 404


def test_secure_response_applies_security_headers_and_api_no_store(client):
    response = client.get("/api/health")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    assert "script-src 'self'" in response.headers["Content-Security-Policy"]
    assert response.headers["Referrer-Policy"] == "same-origin"
    assert "camera=()" in response.headers["Permissions-Policy"]
    assert response.headers["Cache-Control"] == "no-store"
    assert "Strict-Transport-Security" not in response.headers


def test_secure_response_adds_hsts_in_production(app):
    app.config["MDR_PRODUCTION"] = True
    assert "max-age=31536000" in app.test_client().get("/").headers["Strict-Transport-Security"]


def test_http_error_serializes_missing_routes_and_method_errors(client):
    missing = client.get("/api/missing")
    assert missing.status_code == 404 and isinstance(missing.get_json()["error"], str)
    wrong_method = client.get("/api/session")
    assert wrong_method.status_code == 405 and "error" in wrong_method.get_json()


def test_http_error_rejects_oversized_request(client):
    response = client.post("/api/session", json={"file": "x" * 20_000})
    assert response.status_code == 413 and "error" in response.get_json()


def test_value_error_serializes_domain_validation(client):
    response = client.post("/api/session", json={"mode": "supervisor"})
    assert response.status_code == 400 and "mode" in response.get_json()["error"]


@pytest.mark.parametrize("body", [None, [], "text", {"extra": 1}, {"mode": []}, {"file": None}])
def test_read_body_and_new_session_reject_invalid_json_objects(client, body):
    response = client.post("/api/session", json=body)
    assert response.status_code == 400 and "error" in response.get_json()


def test_read_body_rejects_malformed_json_and_non_json_content(client):
    assert client.post("/api/session", data="{broken", content_type="application/json").status_code == 400
    assert client.post("/api/session", data="mode=standard").status_code == 400


@pytest.mark.parametrize("path,body", [("/api/restore", {}), ("/api/restore", {"token": "fake", "score": 100}), ("/api/refine", {"token": "fake", "cells": []})])
def test_read_body_requires_expected_fields_and_rejects_unknown_fields(client, path, body):
    assert client.post(path, json=body).status_code == 400


@pytest.mark.parametrize("mode,remaining,strikes", [("standard", 900, 5), ("orientation", None, 8), ("overtime", 480, 3)])
def test_new_session_returns_complete_state_contract(client, mode, remaining, strikes):
    response = client.post("/api/session", json={"mode": mode, "file": "Siena"})
    assert response.status_code == 200
    body = response.get_json()
    assert isinstance(body["token"], str)
    state = body["state"]
    assert state["mode"] == mode and state["file"] == "Siena"
    assert state["remaining_seconds"] == remaining and state["max_mistakes"] == strikes
    assert state["status"] == "active" and state["progress"] == 0
    assert len(state["board"]["cells"]) == 200 and len(state["bins"]) == 5


def test_new_session_defaults_and_restore_session_preserve_signed_state(client):
    original = client.post("/api/session", json={}).get_json()
    response = client.post("/api/restore", json={"token": original["token"]})
    assert response.status_code == 200
    assert response.get_json()["state"] == original["state"]
    assert original["state"]["file"] == "Cold Harbor"


def test_invalid_session_rejects_forged_and_wrong_type_tokens(client):
    for token in ["forged", None, 123, "x" * 9000]:
        response = client.post("/api/restore", json={"token": token})
        assert response.status_code == 400 and "error" in response.get_json()


def test_expired_session_returns_410(client, monkeypatch):
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000)
    token = client.post("/api/session", json={}).get_json()["token"]
    monkeypatch.setattr("itsdangerous.TimestampSigner.get_timestamp", lambda self: 1000 + TOKEN_MAX_AGE + 1)
    response = client.post("/api/restore", json={"token": token})
    assert response.status_code == 410 and "expired" in response.get_json()["error"]


def test_restore_session_returns_failed_state_after_game_deadline(client, app):
    original = client.post("/api/session", json={}).get_json()
    app.extensions["mdr_service"].clock = lambda: 1900
    response = client.post("/api/restore", json={"token": original["token"]})
    assert response.status_code == 200
    assert response.get_json()["state"]["status"] == "failed"


def test_refine_session_validates_moves_and_returns_new_signed_progress(client):
    original = client.post("/api/session", json={}).get_json()
    cluster = original["state"]["board"]["clusters"][0]
    response = client.post("/api/refine", json={"token": original["token"], "cells": cluster["cells"], "bin": cluster["bin"]})
    assert response.status_code == 200
    refined = response.get_json()
    assert refined["feedback"]["accepted"] is True
    assert refined["state"]["progress"] == 5 and refined["state"]["score"] == 100
    restored = client.post("/api/restore", json={"token": refined["token"]}).get_json()
    assert restored["state"]["score"] == 100
    # An old token is a permitted alternate history, never an aggregate score.
    assert client.post("/api/restore", json={"token": original["token"]}).get_json()["state"]["score"] == 0


def test_refine_session_invalid_gameplay_is_feedback_but_bad_types_are_400(client):
    token = client.post("/api/session", json={}).get_json()["token"]
    response = client.post("/api/refine", json={"token": token, "cells": [], "bin": 1})
    assert response.status_code == 200
    assert response.get_json()["feedback"]["accepted"] is False
    assert response.get_json()["state"]["mistakes"] == 1
    for cells, bin_id in [([False], 1), ([], True), ([0, 0], 1), ([200], 1)]:
        assert client.post("/api/refine", json={"token": token, "cells": cells, "bin": bin_id}).status_code == 400


def test_refine_session_full_win_survives_restore(client):
    response = client.post("/api/session", json={}).get_json()
    for _ in range(4):
        clusters = response["state"]["board"]["clusters"]
        for cluster in clusters:
            result = client.post("/api/refine", json={"token": response["token"], "cells": cluster["cells"], "bin": cluster["bin"]})
            assert result.status_code == 200
            response = result.get_json()
    assert response["state"]["status"] == "completed"
    assert response["state"]["progress"] == 100
    final = client.post("/api/restore", json={"token": response["token"]}).get_json()
    assert final["state"]["status"] == "completed"
    assert all(bin_["progress"] == 100 for bin_ in final["state"]["bins"])
