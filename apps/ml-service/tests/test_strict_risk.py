import io
import json
import math
import threading
from pathlib import Path

import joblib
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import strict_risk_http as transport
from app.features import NUMERIC_FEATURES
from app.strict_risk import (
    CONTRACT,
    SCHEMA,
    Features,
    PairRequest,
    SafeFailure,
    StrictRegistry,
    canonical,
    manifest_for,
    read_regular,
)


class Transformer:
    def transform(self, frame):
        return frame[NUMERIC_FEATURES].to_numpy(dtype=float)


class Classifier:
    def __init__(self, probability=0.911):
        self.probability = probability

    def predict_proba(self, matrix):
        return np.array([[1 - self.probability, self.probability]])


def write_bundle(directory: Path, probability=0.911, name="models"):
    directory.mkdir(parents=True, exist_ok=True)
    bundle = {
        "feature_schema_version": 1,
        "transformer": Transformer(),
        "risk_model_calibrated": Classifier(probability),
        "active_risk_model_name": "test-only",
        "model_version": "test-v1",
        "is_baseline": True,
    }
    buffer = io.BytesIO()
    joblib.dump(bundle, buffer, protocol=5)
    data = buffer.getvalue()
    path = directory / f"{name}.joblib"
    path.write_bytes(data)
    path.with_suffix(".manifest.json").write_bytes(
        canonical(manifest_for(data, bundle).model_dump())
    )
    return path


@pytest.fixture
def features():
    return {
        **dict.fromkeys(NUMERIC_FEATURES, 0),
        "files_changed": 1,
        "lines_added": 4,
        "title_text": "test change",
        "commit_text": "test commit",
    }


@pytest.fixture
def engine(tmp_path):
    write_bundle(tmp_path / "shared")
    return StrictRegistry(tmp_path / "shared", tmp_path / "org", "test-only-runtime")


def pair(features):
    return PairRequest(
        contractVersion=CONTRACT, featureSchemaVersion=SCHEMA, original=features, patched=features
    )


@pytest.mark.parametrize("field", [*NUMERIC_FEATURES, "title_text", "commit_text"])
def test_requires_each_field(features, field):
    del features[field]
    with pytest.raises(ValidationError):
        Features.model_validate(features)


@pytest.mark.parametrize(
    "value", ["1", True, None, -1, 1000001, 1.5, math.nan, math.inf, -math.inf]
)
def test_strict_counts(features, value):
    with pytest.raises(ValidationError):
        Features.model_validate({**features, "lines_added": value})


@pytest.mark.parametrize("value", ["1", True, math.nan, math.inf, -math.inf, 0.0001, 1000001])
def test_complexity(features, value):
    with pytest.raises(ValidationError):
        Features.model_validate({**features, "complexity_delta": value})


def test_unknown_and_text_bounds(features):
    for extra in [
        {"unknown": 0},
        {"title_text": "a" * 301},
        {"commit_text": "a" * 2001},
        {"files_changed": 0},
        {"previous_risky_file_count": 2},
    ]:
        with pytest.raises(ValidationError):
            Features.model_validate({**features, **extra})
    assert Features.model_validate({**features, "title_text": " e\u0301\n x "}).title_text == "é x"


def test_versions_and_no_model_selection(features):
    raw = pair(features).model_dump()
    for extra in [
        {"contractVersion": "v2"},
        {"featureSchemaVersion": "v2"},
        {"model": "other"},
        {"includeExplanation": True},
        {"organizationId": "../other"},
    ]:
        with pytest.raises(ValidationError):
            PairRequest.model_validate({**raw, **extra})


def test_stable_repeated_pairs_and_restart(engine, features):
    request = pair(features)
    first = canonical(engine.infer(request))
    for _ in range(25):
        assert canonical(engine.infer(request)) == first
    fresh = StrictRegistry(engine.shared, engine.organizations, engine.runtime)
    assert canonical(fresh.infer(request)) == first


def test_artifact_digest_and_manifest_mismatch(engine, features):
    manifest_path = engine.shared / "models.manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["artifactDigest"] = "f" * 64
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(SafeFailure, match="ARTIFACT_DIGEST_MISMATCH"):
        engine.infer(pair(features))


@pytest.mark.parametrize(
    "field", ["preprocessingDigest", "calibrationDigest", "featureSchemaVersion"]
)
def test_component_identity_fail_closed(engine, features, field):
    path = engine.shared / "models.manifest.json"
    manifest = json.loads(path.read_bytes())
    manifest[field] = "f" * 64
    path.write_text(json.dumps(manifest))
    with pytest.raises(SafeFailure):
        engine.infer(pair(features))


def test_regular_file_bound(tmp_path):
    path = tmp_path / "artifact"
    path.write_bytes(b"abcd")
    with pytest.raises(SafeFailure):
        read_regular(path, 3)
    with pytest.raises(SafeFailure):
        read_regular(tmp_path, 30)


def test_unverified_artifact_never_deserialized(engine, features, monkeypatch):
    path = engine.shared / "models.joblib"
    path.write_bytes(b"not the operator manifest bytes")
    load = []
    monkeypatch.setattr(joblib, "load", lambda *_: load.append(True))
    with pytest.raises(SafeFailure, match="ARTIFACT_DIGEST_MISMATCH"):
        engine.infer(pair(features))
    assert not load


def test_invalid_reload_fails_new_requests(engine, features):
    first = engine.infer(pair(features))
    assert first["status"] == "AVAILABLE"
    (engine.shared / "models.manifest.json").write_bytes(b"invalid")
    engine.reload()
    with pytest.raises(SafeFailure):
        engine.infer(pair(features))


@pytest.mark.parametrize(
    "field,limit",
    [
        ("lines_added", 1000000),
        ("lines_deleted", 1000000),
        ("files_changed", 1000),
        ("number_of_commits", 10000),
        ("security_findings_count", 10000),
        ("dependency_changed", 1),
        ("test_files_changed", 1),
        ("auth_file_changed", 1),
        ("database_file_changed", 1),
        ("config_file_changed", 1),
        ("payment_file_changed", 1),
        ("previous_risky_file_count", 1000),
    ],
)
def test_each_numeric_bound(features, field, limit):
    with pytest.raises(ValidationError):
        Features.model_validate({**features, field: limit + 1})


def test_single_repetitions(engine, features):
    from app.strict_risk import SingleRequest

    request = SingleRequest(
        contractVersion=CONTRACT, featureSchemaVersion=SCHEMA, features=features
    )
    values = [canonical(engine.infer(request)) for _ in range(25)]
    assert len(set(values)) == 1


def test_operator_reload_disabled_by_default(monkeypatch):
    from app.main import app

    monkeypatch.delenv("ML_ENABLE_OPERATOR_RELOAD", raising=False)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/models/reload")
    assert response.status_code == 403
    assert response.json() == {"detail": "OPERATOR_RELOAD_DISABLED"}


def test_org_selection_no_invalid_fallback(engine, features):
    write_bundle(engine.organizations, probability=0.2, name="tenant")
    request = pair(features).model_copy(update={"organizationId": "tenant"})
    assert engine.infer(request)["identity"]["bundleScope"] == "ORGANIZATION"
    engine.reload()
    (engine.organizations / "tenant.manifest.json").unlink()
    with pytest.raises(SafeFailure):
        engine.infer(request)


def test_reload_between_halves_retains_selected_bundle(engine, features, monkeypatch):
    observe = engine.observe
    called = False

    def changed(selected, data):
        nonlocal called
        result = observe(selected, data)
        if not called:
            called = True
            write_bundle(engine.shared, 0.2)
            engine.reload()
        return result

    monkeypatch.setattr(engine, "observe", changed)
    result = engine.infer(pair(features))
    assert result["original"] == result["patched"]
    assert (
        engine.infer(pair(features))["identity"]["artifactDigest"]
        != result["identity"]["artifactDigest"]
    )


@pytest.mark.parametrize(
    "probability,confidence,band",
    [
        (0.349, 0.8, "LOW"),
        (0.35, 0.8, "MEDIUM"),
        (0.599, 0.8, "MEDIUM"),
        (0.60, 0.8, "HIGH"),
        (0.849, 0.8, "HIGH"),
        (0.85, 0.35, "CRITICAL"),
        (0.85, 0.349, "HIGH"),
    ],
)
def test_thresholds(engine, features, monkeypatch, probability, confidence, band):
    from app.strict_risk import registry

    monkeypatch.setattr(registry, "_estimate_confidence", lambda *_: confidence)
    selected, _ = engine.select(None)
    selected.bundle["risk_model_calibrated"].probability = probability
    assert engine.observe(selected, Features.model_validate(features)).band == band


@pytest.mark.parametrize("probability", [math.nan, math.inf, -0.1, 1.1])
def test_invalid_model_outputs(engine, features, probability):
    selected, _ = engine.select(None)
    selected.bundle["risk_model_calibrated"].probability = probability
    with pytest.raises(SafeFailure, match="MODEL_OUTPUT_INVALID"):
        engine.infer(pair(features))


def test_no_change_is_not_a_zero_prediction(engine, features):
    features.update(files_changed=0, lines_added=0)
    with pytest.raises(SafeFailure, match="NO_MODEL_ASSESSMENT"):
        engine.infer(pair(features))


@pytest.fixture
def client(engine, monkeypatch):
    monkeypatch.setattr(transport, "engine", engine)
    app = FastAPI()
    app.include_router(transport.router)
    with TestClient(app) as client:
        yield client


def test_http_success_and_rejection(client, features):
    raw = pair(features).model_dump()
    first = client.post("/internal/risk/v1/pair", json=raw)
    assert first.status_code == 200
    for _ in range(10):
        assert client.post("/internal/risk/v1/pair", json=raw).content == first.content
    assert client.post("/internal/risk/v1/pair", content=b"x" * 32769).status_code == 413
    for bad in [b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}', b'{"a":1,"a":2}']:
        response = client.post("/internal/risk/v1/pair", content=bad)
        assert response.status_code == 422
        assert "original" not in response.json()


def test_single_http(client, features):
    response = client.post(
        "/internal/risk/v1",
        json={"contractVersion": CONTRACT, "featureSchemaVersion": SCHEMA, "features": features},
    )
    assert response.status_code == 200
    assert response.json()["observation"]["scoreTenths"] == 911


def test_timeout_retains_admission_and_sanitizes(client, engine, features, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow(_):
        started.set()
        release.wait(5)
        raise RuntimeError("SECRET_MARKER /operator/path")

    monkeypatch.setattr(engine, "infer", slow)
    monkeypatch.setattr(transport, "DEADLINE_SECONDS", 0.03)
    try:
        response = client.post("/internal/risk/v1/pair", json=pair(features).model_dump())
        assert started.is_set()
        assert response.status_code == 504
        assert response.json()["category"] == "TIMEOUT"
        assert (
            client.post("/internal/risk/v1/pair", json=pair(features).model_dump()).status_code
            == 429
        )
        assert "SECRET_MARKER" not in response.text
    finally:
        release.set()


def test_http_error_no_exception_values(client, engine, features, monkeypatch):
    def broken(_):
        raise RuntimeError("SECRET_MARKER /operator/path")

    monkeypatch.setattr(engine, "infer", broken)
    response = client.post("/internal/risk/v1/pair", json=pair(features).model_dump())
    assert response.json() == {
        "status": "UNAVAILABLE",
        "contractVersion": CONTRACT,
        "category": "INFERENCE_FAILED",
    }
