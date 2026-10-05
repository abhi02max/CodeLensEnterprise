"""Internal, artifact-bound inference. Inputs are data, never executable source."""

from __future__ import annotations

import hashlib
import importlib.metadata
import io
import json
import math
import os
import platform
import re
import stat
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal

import joblib
import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.features import FEATURE_SCHEMA_VERSION, to_dataframe
from app.registry import registry, risk_level_from_score

CONTRACT = "codelens-risk-inference-v1"
SCHEMA = "codelens-risk-features-v1"
IMPLEMENTATION = "codelens-risk-inference-impl-v1"
BAND_POLICY = "risk-band-policy-v1"
REQUEST_BYTES = 32768
RESPONSE_BYTES = 16384
ARTIFACT_BYTES = 256 * 1024 * 1024


class SafeFailure(Exception):
    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


Count = Annotated[int, Field(ge=0, le=1000000)]
Flag = Annotated[int, Field(ge=0, le=1)]
Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Name = Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]{1,80}$")]


class Features(StrictModel):
    lines_added: Count
    lines_deleted: Count
    files_changed: Annotated[int, Field(ge=0, le=1000)]
    number_of_commits: Annotated[int, Field(ge=0, le=10000)]
    complexity_delta: Annotated[float, Field(ge=-1000000, le=1000000)]
    security_findings_count: Annotated[int, Field(ge=0, le=10000)]
    dependency_changed: Flag
    test_files_changed: Flag
    auth_file_changed: Flag
    database_file_changed: Flag
    config_file_changed: Flag
    payment_file_changed: Flag
    previous_risky_file_count: Annotated[int, Field(ge=0, le=1000)]
    title_text: Annotated[str, Field(max_length=300)]
    commit_text: Annotated[str, Field(max_length=2000)]

    @field_validator("complexity_delta", mode="before")
    @classmethod
    def finite_complexity(cls, value: Any) -> float:
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("INVALID_NUMBER")
        if abs(value * 1000 - round(value * 1000)) > 1e-7:
            raise ValueError("INVALID_PRECISION")
        return float(value)

    @field_validator("title_text", "commit_text")
    @classmethod
    def text(cls, value: str) -> str:
        value = unicodedata.normalize("NFC", value)
        value = re.sub(r"[ \t\r\n\f\v]+", " ", value).strip(" ")
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("INVALID_TEXT")
        return value

    @model_validator(mode="after")
    def consistent(self):
        if len(self.title_text) > 300 or len(self.commit_text) > 2000:
            raise ValueError("INVALID_TEXT_BOUND")
        if not self.files_changed and (self.lines_added or self.lines_deleted):
            raise ValueError("INCONSISTENT_CHANGE")
        if self.previous_risky_file_count > self.files_changed:
            raise ValueError("INCONSISTENT_HISTORY")
        return self

    def normalized(self) -> dict[str, Any]:
        values = self.model_dump()
        n = values["complexity_delta"]
        values["complexity_delta"] = int(n) if n.is_integer() else n
        return values


class PairRequest(StrictModel):
    contractVersion: Literal[CONTRACT]
    featureSchemaVersion: Literal[SCHEMA]
    organizationId: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")] | None = None
    original: Features
    patched: Features


class SingleRequest(StrictModel):
    contractVersion: Literal[CONTRACT]
    featureSchemaVersion: Literal[SCHEMA]
    organizationId: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")] | None = None
    features: Features


class Manifest(StrictModel):
    manifestVersion: Literal[1]
    featureSchemaVersion: Literal[SCHEMA]
    artifactDigest: Hash
    preprocessingDigest: Hash
    calibrationDigest: Hash
    modelName: Name
    modelVersion: Name
    isBaseline: bool


class Identity(Manifest):
    contractVersion: Literal[CONTRACT] = CONTRACT
    inferenceImplementation: Literal[IMPLEMENTATION] = IMPLEMENTATION
    bandPolicyVersion: Literal[BAND_POLICY] = BAND_POLICY
    bundleScope: Literal["SHARED", "ORGANIZATION"]
    organizationId: str | None
    runtimeIdentity: Annotated[str, Field(max_length=128)]
    implementationDigest: Hash
    runtimeDigest: Hash


class Observation(StrictModel):
    featureDigest: Hash
    scoreTenths: Annotated[int, Field(ge=0, le=1000)]
    probabilityMicros: Annotated[int, Field(ge=0, le=1000000)]
    confidenceMillis: Annotated[int, Field(ge=0, le=1000)]
    band: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    warnings: Annotated[
        list[Literal["LOW_CONFIDENCE_CAP", "PROBABILITY_CLAMPED"]], Field(max_length=2)
    ]


def component_digest(component: Any, artifact_digest: str, role: str) -> str:
    # Re-pickling sklearn objects is load-order dependent. Bind the component's
    # identity to its exact containing artifact, not a second serialization.
    return digest(
        {
            "artifactDigest": artifact_digest,
            "component": role,
            "class": f"{type(component).__module__}.{type(component).__qualname__}",
            "featureSchemaVersion": SCHEMA,
        }
    )


def read_regular(path: Path, limit: int) -> bytes:
    try:
        if path.is_symlink() or not stat.S_ISREG(path.lstat().st_mode):
            raise SafeFailure("ARTIFACT_INVALID")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise SafeFailure("ARTIFACT_INVALID")
            data = file.read(limit + 1)
        if len(data) > limit:
            raise SafeFailure("ARTIFACT_INVALID")
        return data
    except SafeFailure:
        raise
    except Exception:
        raise SafeFailure("ARTIFACT_UNAVAILABLE") from None


def manifest_for(data: bytes, bundle: dict[str, Any]) -> Manifest:
    if bundle.get("feature_schema_version") != FEATURE_SCHEMA_VERSION:
        raise SafeFailure("ARTIFACT_SCHEMA_MISMATCH")
    model = bundle.get("risk_model_calibrated")
    if model is None:
        raise SafeFailure("CALIBRATION_UNAVAILABLE")
    artifact_digest = hashlib.sha256(data).hexdigest()
    return Manifest(
        manifestVersion=1,
        featureSchemaVersion=SCHEMA,
        artifactDigest=artifact_digest,
        preprocessingDigest=component_digest(bundle["transformer"], artifact_digest, "transformer"),
        calibrationDigest=component_digest(model, artifact_digest, "risk_model_calibrated"),
        modelName=bundle["active_risk_model_name"],
        modelVersion=bundle["model_version"],
        isBaseline=bundle["is_baseline"],
    )


@dataclass(frozen=True)
class SelectedBundle:
    bundle: dict[str, Any]
    manifest: Manifest


class StrictRegistry:
    def __init__(self, shared: Path, organizations: Path, runtime: str):
        self.shared = shared.resolve()
        self.organizations = organizations.resolve()
        self.runtime = runtime
        if not re.fullmatch(r"[A-Za-z0-9_.:@/-]{1,128}", runtime):
            raise SafeFailure("RUNTIME_IDENTITY_INVALID")
        self.lock = threading.RLock()
        self.implementation_digest = digest(
            {
                name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                for name in ("strict_risk.py", "features.py", "registry.py")
            }
        )
        self.runtime_digest = digest(
            {
                "python": platform.python_version(),
                "platform": platform.platform(),
                "libraries": {
                    name: importlib.metadata.version(name)
                    for name in ("numpy", "pandas", "scikit-learn", "joblib", "xgboost", "pydantic")
                },
            }
        )
        self.cache: dict[Path, SelectedBundle] = {}

    def select(self, organization_id: str | None) -> tuple[SelectedBundle, Identity]:
        with self.lock:
            path = self.shared / "models.joblib"
            scope = "SHARED"
            if organization_id is not None:
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", organization_id):
                    raise SafeFailure("INVALID_REQUEST")
                org = self.organizations / f"{organization_id}.joblib"
                if org.exists() or org.is_symlink():
                    path, scope = org, "ORGANIZATION"
            selected = self.cache.get(path)
            if selected is None:
                try:
                    manifest = Manifest.model_validate_json(
                        read_regular(path.with_suffix(".manifest.json"), 8192)
                    )
                    data = read_regular(path, ARTIFACT_BYTES)
                    if hashlib.sha256(data).hexdigest() != manifest.artifactDigest:
                        raise SafeFailure("ARTIFACT_DIGEST_MISMATCH")
                    # Only an operator-trusted, manifest-verified byte buffer is deserialized.
                    bundle = joblib.load(io.BytesIO(data))
                    if manifest_for(data, bundle) != manifest:
                        raise SafeFailure("ARTIFACT_MANIFEST_MISMATCH")
                    selected = SelectedBundle(bundle, manifest)
                    if len(self.cache) >= 4:
                        raise SafeFailure("BUSY")
                    self.cache[path] = selected
                except SafeFailure:
                    raise
                except Exception:
                    raise SafeFailure("ARTIFACT_INVALID") from None
            identity = Identity(
                **selected.manifest.model_dump(),
                bundleScope=scope,
                organizationId=organization_id if scope == "ORGANIZATION" else None,
                runtimeIdentity=self.runtime,
                implementationDigest=self.implementation_digest,
                runtimeDigest=self.runtime_digest,
            )
            return selected, identity

    def reload(self):
        # Operator-only in-process operation; active calls retain their selected objects.
        with self.lock:
            self.cache.clear()

    def observe(self, selected: SelectedBundle, features: Features) -> Observation:
        values = features.normalized()
        if not values["files_changed"]:
            raise SafeFailure("NO_MODEL_ASSESSMENT")
        try:
            matrix = selected.bundle["transformer"].transform(to_dataframe([values]))
            probabilities = np.asarray(
                selected.bundle["risk_model_calibrated"].predict_proba(matrix)
            )
            if (
                probabilities.shape != (1, 2)
                or not np.isfinite(probabilities).all()
                or not ((probabilities >= 0) & (probabilities <= 1)).all()
                or abs(float(probabilities.sum()) - 1) > 1e-6
            ):
                raise SafeFailure("MODEL_OUTPUT_INVALID")
            raw = float(probabilities[0, 1])
            probability = min(0.995, max(0.005, raw))
            score = round(probability * 100, 1)
            confidence = registry._estimate_confidence(selected.bundle, matrix, probability)
            if not math.isfinite(confidence) or not 0 <= confidence <= 1:
                raise SafeFailure("MODEL_OUTPUT_INVALID")
            band = risk_level_from_score(score)
            warnings = []
            if confidence < 0.35 and band == "CRITICAL":
                band = "HIGH"
                warnings.append("LOW_CONFIDENCE_CAP")
            if raw >= 0.995 or raw <= 0.005:
                warnings.append("PROBABILITY_CLAMPED")
            return Observation(
                featureDigest=digest(values),
                scoreTenths=round(score * 10),
                probabilityMicros=round(probability * 1000000),
                confidenceMillis=round(confidence * 1000),
                band=band,
                warnings=warnings,
            )
        except SafeFailure:
            raise
        except Exception:
            raise SafeFailure("INFERENCE_FAILED") from None

    def infer(self, request: PairRequest | SingleRequest) -> dict[str, Any]:
        selected, identity = self.select(request.organizationId)
        result: dict[str, Any] = {"status": "AVAILABLE", "identity": identity.model_dump()}
        if isinstance(request, PairRequest):
            result["original"] = self.observe(selected, request.original).model_dump()
            result["patched"] = self.observe(selected, request.patched).model_dump()
        else:
            result["observation"] = self.observe(selected, request.features).model_dump()
        result["resultDigest"] = digest(result)
        if len(canonical(result)) > RESPONSE_BYTES:
            raise SafeFailure("RESPONSE_BOUND")
        return result
