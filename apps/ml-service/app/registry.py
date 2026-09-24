"""Model loading and inference.

Holds the loaded joblib bundle and turns feature records into predictions. Three
things here are worth more than the mechanics:

* RISK BANDS MATCH THE TYPESCRIPT SIDE. ``RISK_THRESHOLDS`` mirrors the constants
  in ``packages/shared/src/constants.ts``. If the two disagree, the API and the UI
  disagree about what "HIGH" means, which is the kind of bug nobody notices for
  months.

* CONFIDENCE IS DISTANCE-BASED, NOT PROBABILITY-BASED. A model is not confident
  just because it output 0.95. It is confident when the input resembles what it was
  trained on. Feature vectors far outside the training distribution get a reduced
  confidence that the UI surfaces, rather than a dressed-up guess.

* SHAP, NOT SELF-REPORTING. Risk reasons come from actual attribution against the
  fitted model. Asking a language model to guess why a score is high produces
  fluent explanations with no connection to the computation.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

from app.config import get_settings
from app.features import (
    FEATURE_EXPLANATIONS,
    FEATURE_LABELS,
    FEATURE_SCHEMA_VERSION,
    NUMERIC_FEATURES,
    to_dataframe,
    validate_features,
)

logger = logging.getLogger(__name__)

# Mirrors RISK_THRESHOLDS in packages/shared/src/constants.ts.
RISK_THRESHOLDS = {"MEDIUM": 35, "HIGH": 60, "CRITICAL": 85}


def risk_level_from_score(score: float) -> str:
    if score >= RISK_THRESHOLDS["CRITICAL"]:
        return "CRITICAL"
    if score >= RISK_THRESHOLDS["HIGH"]:
        return "HIGH"
    if score >= RISK_THRESHOLDS["MEDIUM"]:
        return "MEDIUM"
    return "LOW"


class ModelRegistry:
    """Thread-safe holder for loaded model bundles."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._bundle: dict[str, Any] | None = None
        self._org_bundles: dict[str, dict[str, Any]] = {}
        self._report: dict[str, Any] | None = None
        self._explainer: Any | None = None
        self._explainer_failed = False
        self._load_error: str | None = None

    # ---------------------------------------------------------------- loading

    def load(self) -> None:
        settings = get_settings()

        with self._lock:
            if not settings.bundle_path.exists():
                self._load_error = (
                    f"No model bundle at {settings.bundle_path}. "
                    "Run `python scripts/train.py` to produce it."
                )
                logger.warning(self._load_error)
                return

            try:
                self._bundle = joblib.load(settings.bundle_path)
                self._load_error = None

                version = self._bundle.get("feature_schema_version")
                if version != FEATURE_SCHEMA_VERSION:
                    # A stale bundle would be scored against the wrong columns, so
                    # refuse it rather than silently producing wrong numbers.
                    self._load_error = (
                        f"Model bundle was trained on feature schema v{version} but this "
                        f"service expects v{FEATURE_SCHEMA_VERSION}. Retrain before serving."
                    )
                    logger.error(self._load_error)
                    self._bundle = None
                    return

                logger.info(
                    "Loaded models: active=%s version=%s baseline=%s",
                    self._bundle.get("active_risk_model_name"),
                    self._bundle.get("model_version"),
                    self._bundle.get("is_baseline"),
                )
            except Exception as error:  # pragma: no cover
                self._load_error = f"Failed to load model bundle: {error}"
                logger.exception(self._load_error)
                self._bundle = None

            if settings.report_path.exists():
                try:
                    self._report = json.loads(settings.report_path.read_text(encoding="utf-8"))
                except Exception:  # pragma: no cover
                    self._report = None

    @property
    def ready(self) -> bool:
        return self._bundle is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    @property
    def report(self) -> dict[str, Any] | None:
        return self._report

    def bundle_for(self, organization_id: str | None) -> dict[str, Any]:
        """Per-organization bundle when one exists, otherwise the shared one."""
        if self._bundle is None:
            raise RuntimeError(self._load_error or "Models are not loaded")

        if not organization_id:
            return self._bundle

        with self._lock:
            cached = self._org_bundles.get(organization_id)
            if cached is not None:
                return cached

            path: Path = get_settings().org_bundle_path(organization_id)
            if not path.exists():
                return self._bundle

            try:
                bundle = joblib.load(path)
                self._org_bundles[organization_id] = bundle
                logger.info("Loaded per-organization model for %s", organization_id)
                return bundle
            except Exception:  # pragma: no cover
                logger.exception("Failed to load org model for %s; using shared", organization_id)
                return self._bundle

    # ---------------------------------------------------------------- risk

    def predict_risk(
        self,
        features: dict[str, Any],
        organization_id: str | None = None,
        include_explanation: bool = True,
    ) -> dict[str, Any]:
        bundle = self.bundle_for(organization_id)

        warnings = validate_features(features)
        frame = to_dataframe([features])

        # Degenerate input short-circuit.
        #
        # A change with no files and no lines cannot carry risk, but the model has
        # never seen such a vector — the training distribution starts at one line —
        # so it extrapolates and produced 80/100 here before this guard. Returning a
        # deterministic answer is both correct and more defensible than whatever leaf
        # an out-of-distribution input happens to reach.
        if int(frame.iloc[0]["files_changed"]) == 0 and int(frame.iloc[0]["lines_added"]) == 0:
            return {
                "risk_score": 0.0,
                "risk_level": "LOW",
                "probability": 0.0,
                "confidence": 1.0,
                "top_risk_reasons": [],
                "model_name": bundle.get("active_risk_model_name", "unknown"),
                "model_version": bundle.get("model_version", "unknown"),
                "is_baseline": bool(bundle.get("is_baseline", True)),
                "warnings": [
                    *warnings,
                    "No files or lines changed, so no risk was scored by the model.",
                ],
            }

        transformer = bundle["transformer"]
        matrix = transformer.transform(frame)

        # The calibrated model is what produces a probability a human can reason
        # about, so it is preferred over the raw estimator.
        model = bundle.get("risk_model_calibrated") or bundle["risk_model"]
        raw_probability = float(model.predict_proba(matrix)[0, 1])

        # Clamp away from absolute certainty.
        #
        # Isotonic calibration is a step function fitted to the empirical
        # distribution, so it legitimately outputs exactly 0.0 or 1.0 when a test
        # point falls in a terminal bin. Surfacing that as "risk score 100" claims
        # certainty that no model fitted on finite data possesses, and it is
        # actively corrosive to trust: a reviewer who finds one counterexample to a
        # 100 stops believing every score afterwards.
        #
        # 0.5-99.5 preserves the full useful range while keeping the claim honest.
        probability = float(np.clip(raw_probability, 0.005, 0.995))

        score = round(probability * 100, 1)
        confidence = self._estimate_confidence(bundle, matrix, probability)

        level = risk_level_from_score(score)

        # Do not present CRITICAL on a low-confidence prediction.
        #
        # Confidence is low precisely when the feature vector is unlike the training
        # distribution, which is exactly when the model is extrapolating. Escalating
        # such a prediction to the highest band would route a reviewer's attention on
        # the model's weakest evidence, and a few false CRITICALs permanently cost
        # more trust than they buy. The score itself is still reported.
        if confidence < 0.35 and level == "CRITICAL":
            level = "HIGH"
            warnings.append(
                "Prediction confidence is low because this change does not resemble the "
                "model's training data. Severity was capped at HIGH; rely on the static "
                "analysis findings and the diff rather than this score."
            )

        reasons: list[dict[str, Any]] = []
        if include_explanation:
            reasons = self._explain(bundle, matrix, frame)

        if raw_probability >= 0.995 or raw_probability <= 0.005:
            warnings.append(
                "The calibrated probability saturated at its empirical bound and was "
                "clamped; treat this score as 'very high' rather than as a precise value."
            )

        return {
            "risk_score": score,
            "risk_level": level,
            "probability": probability,
            "confidence": confidence,
            "top_risk_reasons": reasons,
            "model_name": bundle.get("active_risk_model_name", "unknown"),
            "model_version": bundle.get("model_version", "unknown"),
            "is_baseline": bool(bundle.get("is_baseline", True)),
            "warnings": warnings,
        }

    def _estimate_confidence(
        self, bundle: dict[str, Any], matrix: np.ndarray, probability: float
    ) -> float:
        """Confidence from distributional distance, not from the probability.

        Two independent penalties:

        1. Distance from the training distribution. A pull request unlike anything
           the model was fitted on gets a lower confidence regardless of how
           decisive the output looks. This is what stops the score being trusted on
           an unusual change.

        2. Proximity to the decision boundary. A probability near 0.5 is genuinely
           uninformative and should read that way.

        A bootstrap model is additionally capped, because no amount of internal
        consistency makes a synthetic-data model authoritative about a real team.
        """
        confidence = 1.0

        background = bundle.get("shap_background")
        if background is not None and len(background) > 0:
            try:
                # Measured over the NUMERIC columns only, which occupy the leading
                # positions of the transformed matrix.
                #
                # Including the latent text components would make this meaningless:
                # their per-column variance is tiny, so any ordinary wording produces
                # enormous z-scores and every prediction reads as low confidence.
                # Familiarity that matters here is structural — is this the size and
                # shape of change the model has seen before.
                n = len(NUMERIC_FEATURES)
                reference = np.asarray(background)[:, :n]

                mean = reference.mean(axis=0)
                std = reference.std(axis=0) + 1e-6

                # Mean absolute z-score, capped so one extreme column cannot zero out
                # the whole estimate.
                z = np.abs((matrix[0][:n] - mean) / std)
                typical_z = float(np.clip(np.mean(z), 0, 6))

                # z of 1 is ordinary; by z of 4 the input is genuinely unfamiliar.
                confidence *= float(np.clip(1.15 - typical_z / 4.0, 0.25, 1.0))
            except Exception:  # pragma: no cover
                pass

        # Boundary proximity: 0.5 -> 0.6x, decisive -> 1.0x.
        decisiveness = abs(probability - 0.5) * 2
        confidence *= 0.6 + 0.4 * decisiveness

        if bundle.get("is_baseline", True):
            confidence = min(confidence, 0.70)

        return round(float(np.clip(confidence, 0.05, 1.0)), 3)

    def _explain(
        self, bundle: dict[str, Any], matrix: np.ndarray, frame: pd.DataFrame
    ) -> list[dict[str, Any]]:
        """SHAP attributions over the numeric features.

        Only numeric features are reported. TF-IDF columns technically carry
        attribution too, but "the token 'skip' contributed +0.04" is not actionable
        for a reviewer, and listing 6000 of them would bury the signal.

        Falls back to a coefficient or impurity-importance approximation when SHAP
        is unavailable, because an explanation panel that sometimes vanishes is
        worse than one that is sometimes approximate — and the fallback is labelled.
        """
        shap_values = self._compute_shap(bundle, matrix)

        if shap_values is None:
            return self._explain_fallback(bundle, frame)

        reasons: list[dict[str, Any]] = []

        # Numeric features occupy the leading columns of the transformed matrix,
        # by construction of the ColumnTransformer in train.py.
        for index, name in enumerate(NUMERIC_FEATURES):
            if index >= len(shap_values):
                break

            contribution = float(shap_values[index])
            if abs(contribution) < 1e-4:
                continue

            raw_value = float(frame.iloc[0][name])
            direction = "INCREASES_RISK" if contribution > 0 else "DECREASES_RISK"
            explanations = FEATURE_EXPLANATIONS.get(name, {})

            reasons.append(
                {
                    "feature": name,
                    "label": FEATURE_LABELS.get(name, name),
                    "value": raw_value,
                    "contribution": round(contribution, 4),
                    "direction": direction,
                    "explanation": explanations.get(
                        "up" if contribution > 0 else "down",
                        f"{FEATURE_LABELS.get(name, name)} influenced the score.",
                    ),
                }
            )

        reasons.sort(key=lambda reason: -abs(reason["contribution"]))
        return reasons[:8]

    def _compute_shap(self, bundle: dict[str, Any], matrix: np.ndarray) -> np.ndarray | None:
        if self._explainer_failed:
            return None

        try:
            import shap
        except ImportError:
            logger.info("shap is not installed; using coefficient-based explanations")
            self._explainer_failed = True
            return None

        try:
            with self._lock:
                if self._explainer is None:
                    # The calibrated wrapper is not a tree, so SHAP is built against
                    # the underlying estimator. Attribution of the uncalibrated score
                    # still correctly identifies *which* features drove it, which is
                    # what the explanation is for.
                    base_model = bundle["risk_model"]
                    background = bundle.get("shap_background")
                    size = get_settings().shap_background_size

                    if hasattr(base_model, "feature_importances_"):
                        self._explainer = shap.TreeExplainer(base_model)
                    elif background is not None:
                        self._explainer = shap.LinearExplainer(
                            base_model, np.asarray(background)[:size]
                        )
                    else:  # pragma: no cover
                        self._explainer_failed = True
                        return None

            values = self._explainer.shap_values(matrix)

            # Shape varies by explainer and model: (n, features), a list per class,
            # or (n, features, classes). Normalize to a single feature vector.
            array = np.asarray(values[1] if isinstance(values, list) else values)
            if array.ndim == 3:
                array = array[..., -1]
            if array.ndim == 2:
                array = array[0]

            return array
        except Exception as error:  # pragma: no cover
            logger.warning("SHAP explanation failed (%s); falling back", error)
            self._explainer_failed = True
            return None

    def _explain_fallback(
        self, bundle: dict[str, Any], frame: pd.DataFrame
    ) -> list[dict[str, Any]]:
        """Approximate attribution when SHAP is unavailable.

        Uses model coefficients or impurity importances multiplied by the
        standardized feature value. Directionally right for linear models, and for
        tree models it identifies influential features without a reliable sign, so
        the sign is derived from the documented heuristic direction instead.
        """
        model = bundle["risk_model"]
        reasons: list[dict[str, Any]] = []

        weights: np.ndarray | None = None
        if hasattr(model, "coef_"):
            weights = np.asarray(model.coef_).ravel()
        elif hasattr(model, "feature_importances_"):
            weights = np.asarray(model.feature_importances_)

        if weights is None:
            return []

        background = bundle.get("shap_background")
        mean = (
            np.asarray(background).mean(axis=0)
            if background is not None and len(background) > 0
            else None
        )

        transformer = bundle["transformer"]
        matrix = transformer.transform(frame)

        for index, name in enumerate(NUMERIC_FEATURES):
            if index >= len(weights):
                break

            centred = float(matrix[0][index] - (mean[index] if mean is not None else 0.0))
            contribution = float(weights[index]) * centred

            if abs(contribution) < 1e-4:
                continue

            explanations = FEATURE_EXPLANATIONS.get(name, {})
            direction = "INCREASES_RISK" if contribution > 0 else "DECREASES_RISK"

            reasons.append(
                {
                    "feature": name,
                    "label": FEATURE_LABELS.get(name, name),
                    "value": float(frame.iloc[0][name]),
                    "contribution": round(contribution, 4),
                    "direction": direction,
                    "explanation": explanations.get(
                        "up" if contribution > 0 else "down",
                        f"{FEATURE_LABELS.get(name, name)} influenced the score.",
                    )
                    + " (approximate attribution: SHAP unavailable)",
                }
            )

        reasons.sort(key=lambda reason: -abs(reason["contribution"]))
        return reasons[:8]

    # ---------------------------------------------------------------- review time

    def predict_review_time(
        self, features: dict[str, Any], organization_id: str | None = None
    ) -> dict[str, Any]:
        bundle = self.bundle_for(organization_id)

        frame = to_dataframe([features])
        matrix = bundle["transformer"].transform(frame)

        # Model was fitted on log1p(minutes), so invert and derive the interval
        # multiplicatively from the residual spread in log space. That keeps the
        # lower bound positive, which an additive interval would not.
        log_prediction = float(bundle["review_time_model"].predict(matrix)[0])
        sigma = float(bundle.get("review_time_residual_sigma", 0.4))

        minutes = float(np.expm1(log_prediction))
        lower = float(np.expm1(log_prediction - 1.28 * sigma))  # ~80% interval
        upper = float(np.expm1(log_prediction + 1.28 * sigma))

        return {
            "minutes": round(max(1.0, minutes), 1),
            "lower_minutes": round(max(1.0, lower), 1),
            "upper_minutes": round(max(minutes, upper), 1),
            "model_version": bundle.get("model_version", "unknown"),
        }

    # ---------------------------------------------------------------- neighbours

    def similar_pull_requests(
        self, features: dict[str, Any], k: int = 5, organization_id: str | None = None
    ) -> dict[str, Any]:
        """Nearest historical pull requests, with what happened to them.

        The outcome is the point. "This resembles PR #287, which was reverted" is
        far more persuasive to a reviewer than any score, because it is a concrete
        precedent from their own repository.
        """
        bundle = self.bundle_for(organization_id)

        frame = to_dataframe([features])
        matrix = bundle["transformer"].transform(frame)

        index = bundle["neighbours_index"]
        metadata: list[dict[str, Any]] = bundle.get("neighbour_metadata", [])

        n_neighbours = min(k, len(metadata)) if metadata else 0
        if n_neighbours == 0:
            return {"neighbours": [], "model_version": bundle.get("model_version", "unknown")}

        distances, indices = index.kneighbors(matrix, n_neighbors=n_neighbours)

        neighbours: list[dict[str, Any]] = []
        for distance, position in zip(distances[0], indices[0], strict=False):
            if position >= len(metadata):
                continue

            record = metadata[int(position)]
            # Cosine distance, so similarity is 1 - distance.
            similarity = float(np.clip(1.0 - float(distance), 0.0, 1.0))

            neighbours.append(
                {
                    "reference": f"historical-{int(position)}",
                    "similarity": round(similarity, 4),
                    "outcome": str(record.get("outcome", "UNKNOWN")),
                    "title": str(record.get("title_text", "")),
                    "risk_score": round(float(record.get("was_risky", 0)) * 100, 1),
                }
            )

        return {"neighbours": neighbours, "model_version": bundle.get("model_version", "unknown")}

    # ---------------------------------------------------------------- clustering

    def cluster_issues(
        self, texts: list[str], organization_id: str | None = None
    ) -> dict[str, Any]:
        """Group finding text into recurring patterns.

        Answers "what mistakes does this team keep making", which is the question a
        team lead actually has. Cluster labels come from the highest-weighted TF-IDF
        terms at each centroid rather than from a language model, so they are cheap
        and reproducible.
        """
        bundle = self.bundle_for(organization_id)

        vectorizer = bundle["issue_vectorizer"]
        kmeans = bundle["kmeans"]

        matrix = vectorizer.transform(texts)
        labels = kmeans.predict(matrix)

        vocabulary = np.asarray(vectorizer.get_feature_names_out())
        centroids = kmeans.cluster_centers_

        clusters: list[dict[str, Any]] = []

        for cluster_id in sorted(set(int(label) for label in labels)):
            members = [i for i, label in enumerate(labels) if int(label) == cluster_id]
            if not members:
                continue

            centroid = centroids[cluster_id]
            top_indices = np.argsort(centroid)[::-1][:6]
            top_terms = [str(vocabulary[i]) for i in top_indices if centroid[i] > 0]

            clusters.append(
                {
                    "cluster_id": cluster_id,
                    "label": " / ".join(top_terms[:3]) if top_terms else f"cluster {cluster_id}",
                    "member_indices": members,
                    "top_terms": top_terms,
                    "size": len(members),
                }
            )

        clusters.sort(key=lambda cluster: -cluster["size"])
        return {"clusters": clusters, "model_version": bundle.get("model_version", "unknown")}

    # ---------------------------------------------------------------- issue type

    def classify_issue_types(self, texts: list[str]) -> dict[str, Any]:
        bundle = self.bundle_for(None)

        vectorizer = bundle["type_vectorizer"]
        model = bundle["svm_issue_type"]

        matrix = vectorizer.transform(texts)
        probabilities = model.predict_proba(matrix)
        classes = [str(cls) for cls in model.classes_]

        predictions: list[dict[str, Any]] = []
        for text, row in zip(texts, probabilities, strict=False):
            best = int(np.argmax(row))
            predictions.append(
                {
                    "text": text,
                    "issue_type": classes[best],
                    "probabilities": {
                        cls: round(float(value), 4)
                        for cls, value in zip(classes, row, strict=False)
                    },
                }
            )

        return {"predictions": predictions, "model_version": bundle.get("model_version", "unknown")}


registry = ModelRegistry()
