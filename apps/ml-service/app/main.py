"""FastAPI application.

Stateless by design: no database access, no knowledge of organizations beyond an
opaque id used to select a model bundle. It takes a feature vector and returns
predictions.

That boundary is deliberate. It means the service can be scaled, redeployed and
retrained independently of the API, and it means the API can lose it entirely and
still produce a review — every endpoint here has a documented degraded path on the
caller's side.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.features import FEATURE_SCHEMA_VERSION
from app.registry import registry
from app.schemas import (
    ClassifyIssueRequest,
    ClassifyIssueResponse,
    ClusterIssuesRequest,
    ClusterIssuesResponse,
    ComparisonRow,
    EmbeddingsRequest,
    EmbeddingsResponse,
    HealthResponse,
    ModelMetrics,
    ModelsInfoResponse,
    PredictReviewTimeRequest,
    PredictReviewTimeResponse,
    PredictRiskRequest,
    PredictRiskResponse,
    SimilarPrsRequest,
    SimilarPrsResponse,
)
from app.strict_risk_http import engine as strict_risk_engine
from app.strict_risk_http import router as strict_risk_router

settings = get_settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("codelens.ml")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Models load at startup so the first request is not penalized by a
    # multi-second joblib read. A missing bundle does not prevent boot: the health
    # endpoint reports `degraded` and the API degrades to no risk score, which is
    # far better than a container that will not start.
    logger.info("Loading model artifacts from %s", settings.artifacts_dir)
    registry.load()

    if registry.ready:
        logger.info("ML service ready")
    else:
        logger.warning("ML service started in degraded mode: %s", registry.load_error)

    yield
    logger.info("ML service shutting down")


app = FastAPI(
    title="CodeLens Enterprise ML Service",
    description=(
        "Pull request risk prediction, review time estimation, similar PR retrieval, "
        "issue clustering and issue type classification."
    ),
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(strict_risk_router)

# The API is the only intended caller. CORS stays closed rather than permissive:
# this service has no authentication of its own and is expected to run on a private
# network, so browser access would be a straightforward way to leak model behaviour.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


def require_models() -> None:
    """Guard for endpoints that cannot degrade.

    503 rather than 500: the caller's circuit breaker should treat this as a
    temporary upstream outage and stop sending traffic, not as a bug to retry hard.
    """
    if not registry.ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=registry.load_error or "Models are not loaded",
        )


# ---------------------------------------------------------------- health


@app.get("/health", response_model=HealthResponse, tags=["meta"])
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if registry.ready else "degraded",
        models_loaded=registry.ready,
        feature_schema_version=FEATURE_SCHEMA_VERSION,
        detail=registry.load_error,
    )


@app.get("/models/info", response_model=ModelsInfoResponse, tags=["meta"])
async def models_info() -> ModelsInfoResponse:
    """Model metadata, metrics and the bagging-vs-boosting comparison table.

    Exposed through the API because model selection is part of the product story.
    An enterprise buyer asking "why should I trust this score" gets the measured
    answer, including which alternatives were evaluated and how they scored.
    """
    require_models()
    report = registry.report or {}

    return ModelsInfoResponse(
        feature_schema_version=report.get("feature_schema_version", FEATURE_SCHEMA_VERSION),
        artifacts_dir=str(settings.artifacts_dir),
        active_risk_model=str(
            registry.bundle_for(None).get("active_risk_model_name", "unknown")
        ),
        models=[ModelMetrics(**entry) for entry in report.get("models", [])],
        comparison=[ComparisonRow(**row) for row in report.get("comparison", [])],
    )


# ---------------------------------------------------------------- risk


@app.post("/predict/risk", response_model=PredictRiskResponse, tags=["risk"])
async def predict_risk(request: PredictRiskRequest) -> PredictRiskResponse:
    require_models()

    try:
        result = registry.predict_risk(
            features=request.features.model_dump(),
            organization_id=request.organization_id,
            include_explanation=request.include_explanation,
        )
    except Exception as error:
        logger.exception("Risk prediction failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Risk prediction failed: {error}",
        ) from error

    return PredictRiskResponse(**result)


@app.post("/predict/review-time", response_model=PredictReviewTimeResponse, tags=["risk"])
async def predict_review_time(
    request: PredictReviewTimeRequest,
) -> PredictReviewTimeResponse:
    require_models()

    try:
        result = registry.predict_review_time(
            features=request.features.model_dump(),
            organization_id=request.organization_id,
        )
    except Exception as error:
        logger.exception("Review time prediction failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Review time prediction failed: {error}",
        ) from error

    return PredictReviewTimeResponse(**result)


# ---------------------------------------------------------------- neighbours


@app.post("/similar/pull-requests", response_model=SimilarPrsResponse, tags=["similarity"])
async def similar_pull_requests(request: SimilarPrsRequest) -> SimilarPrsResponse:
    require_models()

    try:
        result = registry.similar_pull_requests(
            features=request.features.model_dump(),
            k=request.k,
            organization_id=request.organization_id,
        )
    except Exception as error:
        logger.exception("Similar PR lookup failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Similar PR lookup failed: {error}",
        ) from error

    return SimilarPrsResponse(**result)


# ---------------------------------------------------------------- clustering


@app.post("/cluster/issues", response_model=ClusterIssuesResponse, tags=["patterns"])
async def cluster_issues(request: ClusterIssuesRequest) -> ClusterIssuesResponse:
    require_models()

    try:
        result = registry.cluster_issues(
            texts=request.texts, organization_id=request.organization_id
        )
    except Exception as error:
        logger.exception("Issue clustering failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Issue clustering failed: {error}",
        ) from error

    return ClusterIssuesResponse(**result)


@app.post("/classify/issue-type", response_model=ClassifyIssueResponse, tags=["patterns"])
async def classify_issue_type(request: ClassifyIssueRequest) -> ClassifyIssueResponse:
    require_models()

    try:
        result = registry.classify_issue_types(texts=request.texts)
    except Exception as error:
        logger.exception("Issue type classification failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Issue type classification failed: {error}",
        ) from error

    return ClassifyIssueResponse(**result)


# ---------------------------------------------------------------- embeddings

_embedding_model = None


@app.post("/embeddings", response_model=EmbeddingsResponse, tags=["embeddings"])
async def embeddings(request: EmbeddingsRequest) -> EmbeddingsResponse:
    """Local embeddings for organizations that cannot send code to a third party.

    Disabled by default: sentence-transformers pulls in torch, which roughly
    triples the image size and adds a slow import that most deployments never use.
    Enable with ENABLE_LOCAL_EMBEDDINGS=true.
    """
    global _embedding_model

    if not settings.enable_local_embeddings:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                "Local embeddings are disabled. Set ENABLE_LOCAL_EMBEDDINGS=true and install "
                "sentence-transformers to enable them, or use EMBEDDING_PROVIDER=openai."
            ),
        )

    try:
        if _embedding_model is None:
            from sentence_transformers import SentenceTransformer

            model_name = request.model or settings.embedding_model
            logger.info("Loading local embedding model %s", model_name)
            _embedding_model = SentenceTransformer(model_name)

        vectors = _embedding_model.encode(
            request.texts, normalize_embeddings=True, show_progress_bar=False
        )

        return EmbeddingsResponse(
            embeddings=[vector.tolist() for vector in vectors],
            model=request.model or settings.embedding_model,
            dimensions=int(vectors.shape[1]),
        )
    except ImportError as error:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="sentence-transformers is not installed in this image",
        ) from error
    except Exception as error:
        logger.exception("Local embedding failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Local embedding failed: {error}",
        ) from error


# ---------------------------------------------------------------- admin


@app.post("/models/reload", tags=["meta"])
async def reload_models() -> dict[str, object]:
    """Reload artifacts from disk after a retrain, without restarting the service."""
    if os.getenv("ML_ENABLE_OPERATOR_RELOAD", "false").lower() != "true":
        raise HTTPException(status_code=403, detail="OPERATOR_RELOAD_DISABLED")
    registry.load()
    strict_risk_engine.reload()
    return {
        "reloaded": registry.ready,
        "detail": registry.load_error,
        "active_risk_model": (
            registry.bundle_for(None).get("active_risk_model_name") if registry.ready else None
        ),
    }
