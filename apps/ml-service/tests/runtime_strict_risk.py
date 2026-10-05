"""Local-container proof driver, excluded by production Docker COPY rules."""

import json
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from app.features import NUMERIC_FEATURES
from app.strict_risk import CONTRACT, SCHEMA, PairRequest, StrictRegistry, canonical


def post(path, payload, port=8000):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}" + path,
        data=payload if isinstance(payload, bytes) else canonical(payload),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def main():
    features = {
        **dict.fromkeys(NUMERIC_FEATURES, 0),
        "lines_added": 26,
        "lines_deleted": 5,
        "files_changed": 3,
        "number_of_commits": 1,
        "complexity_delta": 2,
        "security_findings_count": 1,
        "test_files_changed": 1,
        "title_text": "Improve request validation",
        "commit_text": "Add validation tests",
    }
    raw = {
        "contractVersion": CONTRACT,
        "featureSchemaVersion": SCHEMA,
        "original": features,
        "patched": features,
    }
    status, first = post("/internal/risk/v1/pair", raw)
    assert status == 200, first
    result = json.loads(first)
    assert result["original"] == result["patched"]
    status, varied_bytes = post(
        "/internal/risk/v1/pair",
        {
            **raw,
            "patched": {
                **features,
                "lines_added": 30,
                "complexity_delta": 1,
                "security_findings_count": 0,
            },
        },
    )
    assert status == 200
    varied = json.loads(varied_bytes)
    assert varied["identity"] == result["identity"]
    assert varied["original"]["featureDigest"] != varied["patched"]["featureDigest"]
    for _ in range(25):
        assert post("/internal/risk/v1/pair", raw) == (200, first)
    single = {"contractVersion": CONTRACT, "featureSchemaVersion": SCHEMA, "features": features}
    status, first_single = post("/internal/risk/v1", single)
    assert status == 200
    for _ in range(25):
        assert post("/internal/risk/v1", single) == (200, first_single)
    for bad in [
        {**raw, "modelUrl": "FORBIDDEN"},
        {**raw, "original": {**features, "title_text": "x" * 301}},
        {**raw, "original": {**features, "lines_added": "26"}},
    ]:
        status, response = post("/internal/risk/v1/pair", bad)
        assert status == 422 and "original" not in json.loads(response)
    status, response = post("/internal/risk/v1/pair", {**raw, "padding": "x" * 32769})
    assert status == 413 and "original" not in json.loads(response)
    no_change = {**features, "lines_added": 0, "lines_deleted": 0, "files_changed": 0}
    status, response = post("/internal/risk/v1/pair", {**raw, "original": no_change})
    assert status == 503 and json.loads(response)["category"] == "NO_MODEL_ASSESSMENT"
    assert post("/models/reload", {})[0] == 403
    for token in ("NaN", "Infinity", "-Infinity"):
        invalid = json.dumps(raw).replace('"lines_added": 26', f'"lines_added": {token}').encode()
        assert post("/internal/risk/v1/pair", invalid)[0] == 422
    # Reload the independent real-artifact primitive during its first half. No HTTP test hooks.
    engine = StrictRegistry(
        __import__("pathlib").Path("/app/artifacts"),
        __import__("pathlib").Path("/app/org-models"),
        result["identity"]["runtimeIdentity"],
    )
    observe = engine.observe

    def reload_during(selected, values):
        value = observe(selected, values)
        engine.reload()
        return value

    engine.observe = reload_during
    replay = engine.infer(PairRequest.model_validate(raw))
    assert replay["original"] == replay["patched"]
    assert replay["identity"] == result["identity"]
    with tempfile.TemporaryDirectory(prefix="ml-proof-") as temporary:
        directory = Path(temporary)
        artifact = Path("/app/artifacts/models.joblib").read_bytes()
        manifest = Path("/app/artifacts/models.manifest.json").read_bytes()
        (directory / "tenant.joblib").write_bytes(artifact)
        (directory / "tenant.manifest.json").write_bytes(manifest)
        scoped = StrictRegistry(
            Path("/app/artifacts"), directory, result["identity"]["runtimeIdentity"]
        )
        request = PairRequest.model_validate({**raw, "organizationId": "tenant"})
        assert scoped.infer(request)["identity"]["bundleScope"] == "ORGANIZATION"
        (directory / "tenant.manifest.json").unlink()
        scoped.reload()
        from app.strict_risk import SafeFailure

        try:
            scoped.infer(request)
            raise AssertionError("Invalid org bundle was accepted")
        except SafeFailure:
            pass
        (directory / "models.joblib").write_bytes(artifact + b"invalid")
        (directory / "models.manifest.json").write_bytes(manifest)
        broken = StrictRegistry(
            directory, directory / "orgs", result["identity"]["runtimeIdentity"]
        )
        try:
            broken.infer(PairRequest.model_validate(raw))
            raise AssertionError("Mismatched artifact was accepted")
        except SafeFailure as error:
            assert error.category == "ARTIFACT_DIGEST_MISMATCH"
    fault_proof(raw)
    if len(sys.argv) > 1:
        assert result["identity"]["artifactDigest"] == sys.argv[1]
    print(
        json.dumps(
            {
                "identity": result["identity"],
                "observation": result["original"],
                "resultDigest": result["resultDigest"],
                "pairRepetitions": 26,
                "singleRepetitions": 26,
                "reloadDuringPair": "PIN_RETAINED",
                "malformedAndOversize": "REJECTED",
                "noChange": "NO_MODEL_ASSESSMENT",
                "faultProof": "TIMEOUT_BUSY_SANITIZED_ORG_FAIL_CLOSED",
                "distinctInputPair": {
                    "originalScoreTenths": varied["original"]["scoreTenths"],
                    "patchedScoreTenths": varied["patched"]["scoreTenths"],
                },
            },
            sort_keys=True,
        )
    )


def fault_proof(raw):
    # Fault injection is confined to this test process, not the running ML service.
    from app import strict_risk_http as transport

    release = threading.Event()
    completed = threading.Event()

    class Delayed:
        def infer(self, _):
            release.wait(5)
            completed.set()
            raise RuntimeError("SYNTHETIC_PRIVATE_MARKER /operator/private")

    transport.engine = Delayed()
    transport.DEADLINE_SECONDS = 0.05
    app = FastAPI()
    app.include_router(transport.router)
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=8001, log_level="error", access_log=False)
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        status, response = post("/internal/risk/v1/pair", raw, 8001)
        assert status == 504 and json.loads(response)["category"] == "TIMEOUT"
        assert b"SYNTHETIC_PRIVATE_MARKER" not in response
        assert post("/internal/risk/v1/pair", raw, 8001)[0] == 429
        release.set()
        assert completed.wait(2)
    finally:
        release.set()
        server.should_exit = True
        thread.join(3)
        assert not thread.is_alive()


if __name__ == "__main__":
    main()
