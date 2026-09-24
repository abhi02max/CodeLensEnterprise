"""Pydantic request and response models.

These mirror the Zod schemas in ``packages/shared/src/contracts/ml.ts``. The API
validates every response from this service against its Zod counterpart, so drift
between the two surfaces as an explicit validation error at the boundary rather
than as a wrong risk score shown to a reviewer.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

RiskLevel = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
Outcome = Literal["APPROVED", "CHANGES_REQUESTED", "REVERTED", "UNKNOWN"]


class PrFeatures(BaseModel):
    """Incoming feature vector.

    ``extra="ignore"`` on purpose: a newer API sending an additional feature should
    get a prediction from the current model rather than a 422. The feature schema
    version in the response tells the caller what was actually used.
    """

    model_config = ConfigDict(extra="ignore")

    lines_added: int = Field(0, ge=0)
    lines_deleted: int = Field(0, ge=0)
    files_changed: int = Field(0, ge=0)
    number_of_commits: int = Field(0, ge=0)
    # Negative is valid: the change reduced complexity.
    complexity_delta: float = 0
    security_findings_count: int = Field(0, ge=0)
    dependency_changed: int = Field(0, ge=0, le=1)
    test_files_changed: int = Field(0, ge=0, le=1)
    auth_file_changed: int = Field(0, ge=0, le=1)
    database_file_changed: int = Field(0, ge=0, le=1)
    config_file_changed: int = Field(0, ge=0, le=1)
    payment_file_changed: int = Field(0, ge=0, le=1)
    previous_risky_file_count: int = Field(0, ge=0)
    title_text: str = ""
    commit_text: str = ""


# ---------------------------------------------------------------- risk


class RiskReason(BaseModel):
    """A single SHAP attribution.

    ``contribution`` is the signed SHAP value in log-odds space; positive pushes
    risk up. ``explanation`` is the plain-language version, because a reviewer
    cannot act on a log-odds delta.
    """

    feature: str
    label: str
    value: float
    contribution: float
    direction: Literal["INCREASES_RISK", "DECREASES_RISK"]
    explanation: str


class PredictRiskRequest(BaseModel):
    features: PrFeatures
    organization_id: str | None = Field(None, alias="organizationId")
    include_explanation: bool = Field(True, alias="includeExplanation")

    model_config = ConfigDict(populate_by_name=True)


class PredictRiskResponse(BaseModel):
    risk_score: float = Field(..., ge=0, le=100)
    risk_level: RiskLevel
    probability: float = Field(..., ge=0, le=1)
    # Reduced when the feature vector sits far from the training distribution.
    # Surfaced rather than hidden, so a reviewer knows when not to trust the score.
    confidence: float = Field(..., ge=0, le=1)
    top_risk_reasons: list[RiskReason] = []
    model_name: str
    model_version: str
    # True when a documented heuristic produced this rather than a model fitted on
    # real review history. The UI labels it as a baseline.
    is_baseline: bool
    warnings: list[str] = []


# ---------------------------------------------------------------- review time


class PredictReviewTimeRequest(BaseModel):
    features: PrFeatures
    organization_id: str | None = Field(None, alias="organizationId")

    model_config = ConfigDict(populate_by_name=True)


class PredictReviewTimeResponse(BaseModel):
    minutes: float = Field(..., ge=0)
    # A point estimate alone is misleading, so an interval is always returned.
    lower_minutes: float = Field(..., ge=0)
    upper_minutes: float = Field(..., ge=0)
    model_version: str


# ---------------------------------------------------------------- similar PRs


class SimilarPrsRequest(BaseModel):
    features: PrFeatures
    k: int = Field(5, ge=1, le=25)
    organization_id: str | None = Field(None, alias="organizationId")

    model_config = ConfigDict(populate_by_name=True)


class SimilarPr(BaseModel):
    reference: str
    similarity: float = Field(..., ge=0, le=1)
    outcome: Outcome
    title: str
    risk_score: float = Field(..., ge=0, le=100)


class SimilarPrsResponse(BaseModel):
    neighbours: list[SimilarPr]
    model_version: str


# ---------------------------------------------------------------- clustering


class ClusterIssuesRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=500)
    organization_id: str | None = Field(None, alias="organizationId")

    model_config = ConfigDict(populate_by_name=True)


class IssueCluster(BaseModel):
    cluster_id: int
    label: str
    member_indices: list[int]
    top_terms: list[str]
    size: int


class ClusterIssuesResponse(BaseModel):
    clusters: list[IssueCluster]
    model_version: str


# ---------------------------------------------------------------- issue typing


class ClassifyIssueRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=500)


class IssuePrediction(BaseModel):
    text: str
    issue_type: str
    probabilities: dict[str, float]


class ClassifyIssueResponse(BaseModel):
    predictions: list[IssuePrediction]
    model_version: str


# ---------------------------------------------------------------- metadata


class ModelMetrics(BaseModel):
    model_name: str
    task: Literal["classification", "regression", "clustering", "neighbours"]
    trained_at: str
    n_samples: int
    metrics: dict[str, float]
    feature_importances: dict[str, float] | None = None


class ComparisonRow(BaseModel):
    """One row of the bagging-vs-boosting experiment table.

    Exposed through the API rather than left in a notebook because the
    model-selection rationale is part of the product: an enterprise buyer asking
    "why XGBoost" deserves the measured answer.
    """

    model_name: str
    roc_auc: float
    f1: float
    precision: float
    recall: float
    accuracy: float
    fit_seconds: float


class ModelsInfoResponse(BaseModel):
    feature_schema_version: int
    artifacts_dir: str
    active_risk_model: str
    models: list[ModelMetrics]
    comparison: list[ComparisonRow]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    models_loaded: bool
    feature_schema_version: int
    # Populated when artifacts are missing, so a deployment problem is visible
    # from the health endpoint rather than only on first prediction.
    detail: str | None = None


# ---------------------------------------------------------------- embeddings


class EmbeddingsRequest(BaseModel):
    """Local embeddings for organizations that cannot send code to a third party.

    Served here rather than in the API because the sentence-transformers model
    already lives in this process.
    """

    texts: list[str] = Field(..., min_length=1, max_length=256)
    model: str | None = None


class EmbeddingsResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dimensions: int
