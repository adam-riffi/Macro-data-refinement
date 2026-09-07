"""Flask entry point for local development and Vercel's Python runtime."""

import os
from pathlib import Path
import time
from typing import Callable

from flask import Flask, abort, jsonify, render_template, request
from werkzeug.exceptions import HTTPException, MethodNotAllowed

from mdr.engine import ExpiredSession, GameSession, InvalidSession, SessionService
from mdr.world import WorldService, WorldSession


LOCAL_SECRET = "mdr-local-development-only-do-not-use-in-production"
ROOT = Path(__file__).resolve().parent


def create_app(config: dict | None = None, clock: Callable[[], float] = time.time) -> Flask:
    app = Flask(__name__, static_folder=str(ROOT / "public"), static_url_path="", template_folder=str(ROOT / "templates"))
    app.config.update(
        MAX_CONTENT_LENGTH=16_384,
        MDR_PRODUCTION=bool(os.environ.get("VERCEL")) or os.environ.get("MDR_ENV") == "production",
        MDR_SECRET_KEY=os.environ.get("MDR_SECRET_KEY"),
    )
    if config:
        app.config.update(config)
    secret = app.config["MDR_SECRET_KEY"]
    if not app.config["MDR_PRODUCTION"] and not secret:
        secret = LOCAL_SECRET
    secret_valid = isinstance(secret, str) and len(secret) >= 32 and len(set(secret)) >= 12
    if app.config["MDR_PRODUCTION"] and secret == LOCAL_SECRET:
        secret_valid = False
    app.extensions["mdr_service"] = SessionService(secret, clock) if secret_valid else None
    app.extensions["world_service"] = WorldService(secret, clock) if secret_valid else None

    @app.before_request
    def check_request():
        if any(part.startswith(".") for part in request.path.split("/") if part):
            return jsonify(error="Not found."), 404
        if request.path.startswith("/api/") and app.extensions["mdr_service"] is None:
            return jsonify(error="Refinement is temporarily unavailable. Configure MDR_SECRET_KEY on the server."), 503
        if request.endpoint == "static" and request.path in {"/api/session", "/api/restore", "/api/refine", "/api/v2/session", "/api/v2/restore", "/api/v2/capture", "/api/v2/mistake"}:
            raise MethodNotAllowed(valid_methods=["POST"])
        return None

    @app.after_request
    def secure_response(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        if app.config["MDR_PRODUCTION"]:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        response = error.get_response()
        response.data = app.json.dumps({"error": error.description})
        response.content_type = "application/json"
        return response

    @app.errorhandler(ValueError)
    def value_error(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(ExpiredSession)
    def expired_session(error):
        return jsonify(error=str(error)), 410

    @app.errorhandler(InvalidSession)
    def invalid_session(error):
        return jsonify(error=str(error)), 400

    def read_body(required: set[str], allowed: set[str]) -> dict:
        try:
            body = request.get_json(silent=True)
        except RecursionError as error:
            raise ValueError("JSON nesting is too deep. Send a simple request object.") from error
        if not isinstance(body, dict) or not required.issubset(body) or set(body) - allowed:
            raise ValueError("Send a JSON object with the required fields and no unknown fields.")
        return body

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", version="1.0.0")

    @app.post("/api/session")
    def new_session():
        body = read_body(set(), {"mode", "file"})
        service = app.extensions["mdr_service"]
        session = GameSession.new(body.get("mode", "standard"), body.get("file", "Cold Harbor"), now=clock())
        return jsonify(service.encode(session))

    @app.post("/api/restore")
    def restore_session():
        body = read_body({"token"}, {"token"})
        service = app.extensions["mdr_service"]
        return jsonify(service.encode(service.decode(body["token"])))

    @app.post("/api/refine")
    def refine_session():
        body = read_body({"token", "cells", "bin"}, {"token", "cells", "bin"})
        service = app.extensions["mdr_service"]
        session = service.decode(body["token"])
        feedback = session.refine(body["cells"], body["bin"], clock())
        return jsonify(**service.encode(session), feedback=feedback)

    @app.post("/api/v2/<action>")
    def world_action(action):
        fields = {"session": (set(), {"mode", "difficulty", "file"}), "restore": ({"token"}, {"token"}), "capture": ({"token", "cluster_id"}, {"token", "cluster_id"}), "mistake": ({"token", "cell"}, {"token", "cell"})}
        if action not in fields:
            abort(404)
        body = read_body(*fields[action])
        service = app.extensions["world_service"]
        if action == "session":
            session = WorldSession.new(body.get("mode", "quota"), body.get("difficulty", "normal"), body.get("file", "Cold Harbor"), clock())
            return jsonify(service.encode(session))
        session = service.decode(body["token"])
        if action == "restore":
            return jsonify(service.encode(session))
        feedback = session.capture(body["cluster_id"], clock()) if action == "capture" else session.mistake(body["cell"], clock())
        return jsonify(**service.encode(session), feedback=feedback)

    return app


app = create_app()
