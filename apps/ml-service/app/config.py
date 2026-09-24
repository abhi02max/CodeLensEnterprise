"""Service configuration."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


class Settings:
    """Environment-driven settings.

    Deliberately plain rather than pydantic-settings: this service has a handful of
    knobs and no secrets, so the extra dependency and indirection buy nothing.
    """

    def __init__(self) -> None:
        self.artifacts_dir = Path(os.getenv("ML_ARTIFACTS_DIR", "artifacts")).resolve()

        # Per-organization models live on a SEPARATE path from the shared bundle,
        # and this separation is load-bearing rather than cosmetic.
        #
        # The shared bundle is build output: it is baked into the image by the
        # Dockerfile so the image is a reproducible unit of deployment. Mounting a
        # named volume over that directory breaks it silently — Docker copies image
        # content into an empty named volume exactly once, so every later rebuild
        # serves the *original* model while appearing to deploy a new one. That bug
        # is invisible until someone notices predictions never change after a retrain.
        #
        # Per-org models are genuinely runtime state produced by retraining against
        # real review history, so they need a volume. Keeping them on their own path
        # lets the image stay immutable and the org models stay persistent.
        self.org_artifacts_dir = Path(
            os.getenv("ML_ORG_ARTIFACTS_DIR", str(self.artifacts_dir / "orgs"))
        ).resolve()
        self.log_level = os.getenv("LOG_LEVEL", "info").upper()
        self.port = int(os.getenv("ML_SERVICE_PORT", "8000"))

        # Local embedding model, used when an organization disables external model
        # calls. Loaded lazily: sentence-transformers pulls in torch, which is a
        # slow and memory-hungry import that most deployments never need.
        self.embedding_model = os.getenv("LOCAL_EMBEDDING_MODEL", "all-MiniLM-L6-v2")
        self.enable_local_embeddings = (
            os.getenv("ENABLE_LOCAL_EMBEDDINGS", "false").lower() == "true"
        )

        # Number of background samples for SHAP. Higher is more faithful but
        # slower; 100 is enough for stable attributions on a 13-feature model.
        self.shap_background_size = int(os.getenv("SHAP_BACKGROUND_SIZE", "100"))

        # How many labelled pull requests an organization needs before it gets its
        # own retrained model rather than the shared bootstrap.
        self.min_samples_for_org_model = int(os.getenv("ML_MIN_SAMPLES_FOR_ORG_MODEL", "200"))

    @property
    def bundle_path(self) -> Path:
        return self.artifacts_dir / "models.joblib"

    @property
    def report_path(self) -> Path:
        return self.artifacts_dir / "model_report.json"

    def org_bundle_path(self, organization_id: str) -> Path:
        """Per-organization model path.

        Risk is a property of a specific team's codebase and review culture, so a
        per-org model consistently beats one global model once there is enough data
        to fit it. Falls back to the shared bundle when absent.
        """
        # Sanitized: the id reaches this service over HTTP, so a crafted value must
        # not be able to traverse out of the artifacts directory.
        safe = "".join(char for char in organization_id if char.isalnum() or char in "-_")
        return self.org_artifacts_dir / f"{safe}.joblib"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
