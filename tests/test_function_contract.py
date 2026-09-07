"""Keep the requested one-dedicated-test-per-function contract explicit.

Coverage alone can accidentally exercise a helper without testing its behavior.
This manifest assigns a named behavioral test to every handwritten production
function, including Flask's nested hooks and class methods. Adding, renaming,
or removing a function requires reviewing its dedicated test assignment.
Dataclass-generated methods and third-party functions are not handwritten code.
"""

import ast
from pathlib import Path


DEDICATED_TESTS = {
    "app.py:create_app": "test_create_app_uses_stable_development_secret",
    "app.py:create_app.check_request": "test_check_request_and_static_routing_protect_private_paths",
    "app.py:create_app.secure_response": "test_secure_response_applies_security_headers_and_api_no_store",
    "app.py:create_app.http_error": "test_http_error_serializes_missing_routes_and_method_errors",
    "app.py:create_app.value_error": "test_value_error_serializes_domain_validation",
    "app.py:create_app.expired_session": "test_expired_session_returns_410",
    "app.py:create_app.invalid_session": "test_invalid_session_rejects_forged_and_wrong_type_tokens",
    "app.py:create_app.read_body": "test_read_body_requires_expected_fields_and_rejects_unknown_fields",
    "app.py:create_app.index": "test_index_renders_the_terminal",
    "app.py:create_app.health": "test_health_returns_minimal_readiness_json",
    "app.py:create_app.new_session": "test_new_session_returns_complete_state_contract",
    "app.py:create_app.restore_session": "test_restore_session_returns_failed_state_after_game_deadline",
    "app.py:create_app.refine_session": "test_refine_session_validates_moves_and_returns_new_signed_progress",
    "mdr/engine.py:BoardGenerator.generate": "test_board_generator_generate_is_deterministic_and_round_specific",
    "mdr/engine.py:GameSession.new": "test_game_session_new_has_defaults_unique_identity_and_trimmed_filename",
    "mdr/engine.py:GameSession.from_payload": "test_game_session_from_payload_round_trips",
    "mdr/engine.py:GameSession.to_payload": "test_game_session_to_payload_is_compact_and_copies_collected_list",
    "mdr/engine.py:GameSession.refresh": "test_game_session_refresh_expires_at_deadline_and_freezes_elapsed",
    "mdr/engine.py:GameSession.refine": "test_game_session_refine_accepts_unordered_exact_cluster_and_builds_streak",
    "mdr/engine.py:GameSession.to_public": "test_game_session_to_public_hides_seed_and_clamps_backwards_clock",
    "mdr/engine.py:SessionService.__init__": "test_session_service_init_rejects_short_secret",
    "mdr/engine.py:SessionService.encode": "test_session_service_encode_returns_signed_state_and_refreshes_expiration",
    "mdr/engine.py:SessionService.decode": "test_session_service_decode_round_trips_signed_session",
}


def test_every_production_function_has_a_dedicated_behavioral_test():
    root = Path(__file__).resolve().parents[1]
    source_paths = sorted(root.glob("*.py")) + sorted((root / "mdr").rglob("*.py"))
    discovered = set()
    for path in source_paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        pending = [(tree, ())]
        while pending:
            node, parents = pending.pop()
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qualified = ".".join((*parents, node.name))
                discovered.add(f"{path.relative_to(root).as_posix()}:{qualified}")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                parents = (*parents, node.name)
            pending.extend((child, parents) for child in ast.iter_child_nodes(node))

    assert discovered == set(DEDICATED_TESTS), (
        f"Functions missing dedicated tests: {sorted(discovered - DEDICATED_TESTS.keys())}; "
        f"stale assignments: {sorted(DEDICATED_TESTS.keys() - discovered)}"
    )
    assert len(set(DEDICATED_TESTS.values())) == len(DEDICATED_TESTS), (
        "Each function must have its own dedicated behavioral test."
    )

    named_tests = {}
    for name in ("test_engine.py", "test_app.py"):
        tree = ast.parse((root / "tests" / name).read_text(encoding="utf-8"))
        named_tests.update({
            node.name: node for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")
        })
    for function, test_name in DEDICATED_TESTS.items():
        assert test_name in named_tests, f"{function} references missing test {test_name}."
        checks = [
            node for node in ast.walk(named_tests[test_name])
            if isinstance(node, ast.Assert) or (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "pytest"
                and node.func.attr == "raises"
            )
        ]
        assert checks, f"{test_name} must assert behavior or an expected exception."
