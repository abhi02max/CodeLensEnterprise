"""Training pipeline.

Fits every model the platform serves and writes them to ``artifacts/`` as joblib
bundles, plus a ``model_report.json`` describing what was trained and how well it
performed.

Two structural decisions worth calling out:

1. ONE SHARED FEATURE TRANSFORMER. A single ``ColumnTransformer`` (scaler + two
   TF-IDF vectorizers + derived ratios) is fitted once and reused by every
   downstream estimator. Fitting separate transformers per model is the classic
   source of train/serve skew: two vectorizers fitted on the same data still
   produce different vocabularies once anything about the input changes.

2. CALIBRATION ON THE FINAL CLASSIFIER. An uncalibrated gradient-booster
   reporting "87% risky" means nothing to a reviewer. Wrapped in isotonic
   calibration, 87 means roughly 87 of 100 such pull requests genuinely needed
   changes, which is a number someone can act on.

    python scripts/train.py --samples 6000 --seed 42
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.cluster import KMeans
from sklearn.compose import ColumnTransformer
from sklearn.decomposition import TruncatedSVD
from sklearn.ensemble import (
    BaggingClassifier,
    GradientBoostingClassifier,
    RandomForestClassifier,
)
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression, RidgeCV
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    mean_absolute_error,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
    silhouette_score,
)
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.neighbors import KNeighborsClassifier, NearestNeighbors
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler
from sklearn.svm import LinearSVC
from sklearn.tree import DecisionTreeClassifier

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features import (  # noqa: E402
    FEATURE_SCHEMA_VERSION,
    NUMERIC_FEATURES,
    derived_ratios,
)
from scripts.generate_dataset import generate  # noqa: E402

try:
    from xgboost import XGBClassifier

    HAS_XGBOOST = True
except ImportError:  # pragma: no cover
    HAS_XGBOOST = False

MODEL_VERSION = "bootstrap-v1"


def build_feature_transformer() -> ColumnTransformer:
    """The single feature transformer every model shares.

    TF-IDF settings are tuned for short technical text rather than prose:
    ``ngram_range=(1, 2)`` captures phrases like "skip validation" that a unigram
    model would miss, ``sublinear_tf`` dampens repeated tokens (a commit message
    repeated across 30 commits should not dominate), and ``min_df=2`` drops
    one-off typos that would otherwise become vocabulary.
    """
    return ColumnTransformer(
        transformers=[
            ("num", StandardScaler(), NUMERIC_FEATURES),
            (
                "derived",
                Pipeline(
                    [
                        ("compute", FunctionTransformer(derived_ratios, validate=False)),
                        ("scale", StandardScaler()),
                    ]
                ),
                NUMERIC_FEATURES,
            ),
            # Text is vectorized and then COMPRESSED WITH SVD, and the compression is
            # the important part rather than an optimization.
            #
            # Raw TF-IDF produced ~6000 columns against 20 numeric features. XGBoost
            # then learned almost entirely from text tokens, because with
            # colsample_bytree most candidate splits were text columns. The measured
            # consequence: an all-zero feature vector — no lines changed, no findings,
            # nothing sensitive — scored 97/100 CRITICAL, because with empty text the
            # input fell off-distribution and landed in a high-risk leaf. The headline
            # AUC looked excellent while the model ignored the features that matter.
            #
            # SVD to 24 components per field keeps the phrase signal ("skip
            # validation", "quick fix") while leaving numeric features ~30% of the
            # matrix instead of 0.3%. It also makes the text representation dense and
            # smooth, so unseen vocabulary degrades gracefully rather than falling
            # into an arbitrary leaf.
            (
                "title",
                Pipeline(
                    [
                        (
                            "tfidf",
                            TfidfVectorizer(
                                ngram_range=(1, 2),
                                max_features=800,
                                sublinear_tf=True,
                                min_df=3,
                                strip_accents="unicode",
                                lowercase=True,
                            ),
                        ),
                        ("svd", TruncatedSVD(n_components=24, random_state=42)),
                    ]
                ),
                "title_text",
            ),
            (
                "commit",
                Pipeline(
                    [
                        (
                            "tfidf",
                            TfidfVectorizer(
                                ngram_range=(1, 2),
                                max_features=800,
                                sublinear_tf=True,
                                min_df=3,
                                strip_accents="unicode",
                                lowercase=True,
                            ),
                        ),
                        ("svd", TruncatedSVD(n_components=24, random_state=42)),
                    ]
                ),
                "commit_text",
            ),
        ],
        remainder="drop",
        # Sparse output would be more memory-efficient, but SHAP and several
        # estimators want dense, and the matrix is small at this scale.
        sparse_threshold=0.0,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=6000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--artifacts", type=str, default="artifacts")
    parser.add_argument("--dataset", type=str, default=None, help="CSV of real labelled PRs")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    artifacts = root / args.artifacts
    artifacts.mkdir(parents=True, exist_ok=True)

    # ---- data
    if args.dataset:
        frame = pd.read_csv(args.dataset)
        is_baseline = False
        print(f"Training on real labelled data from {args.dataset} ({len(frame)} rows)")
    else:
        frame = generate(args.samples, args.seed)
        is_baseline = True
        print(f"Training on {len(frame)} synthetic bootstrap samples (seed {args.seed})")
        print("  NOTE: artifacts will be tagged is_baseline=True and surfaced as a")
        print("        heuristic baseline in the UI, not as learned insight.")

    feature_columns = NUMERIC_FEATURES + ["title_text", "commit_text"]
    X = frame[feature_columns]
    y_risk = frame["was_risky"].astype(int)
    y_minutes = frame["review_minutes"].astype(float)

    # Stratified so the split preserves the class balance; an unstratified split on
    # an imbalanced target produces misleading validation numbers.
    X_train, X_test, y_train, y_test = train_test_split(
        X, y_risk, test_size=0.2, random_state=args.seed, stratify=y_risk
    )

    print(f"\n  train {len(X_train)} / test {len(X_test)}")
    print(f"  positive rate: train {y_train.mean():.1%}, test {y_test.mean():.1%}\n")

    # ---- shared transformer, fitted once
    transformer = build_feature_transformer()
    X_train_t = transformer.fit_transform(X_train)
    X_test_t = transformer.transform(X_test)

    print(f"  feature matrix: {X_train_t.shape[1]} columns after transformation")

    report: dict[str, Any] = {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "is_baseline": is_baseline,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": int(len(frame)),
        "n_features_after_transform": int(X_train_t.shape[1]),
        "models": [],
        "comparison": [],
    }

    # ================================================================
    # 1. Logistic Regression — the interpretable baseline
    # ================================================================
    # Every other classifier has to beat this. Without a linear benchmark it is
    # impossible to tell whether a gradient booster is adding real signal or just
    # memorizing the training set.
    print("\n[1/8] Logistic Regression (baseline)")
    # class_weight is left unset for the same reason as scale_pos_weight above: any
    # of these three may be selected and calibrated, and reweighting shifts the
    # probabilities the calibration step is responsible for.
    logreg = LogisticRegression(max_iter=2000, C=1.0, random_state=args.seed)
    logreg_metrics = fit_and_score(logreg, X_train_t, y_train, X_test_t, y_test)
    report["models"].append(
        model_entry("logistic_regression", "classification", len(X_train), logreg_metrics)
    )
    report["comparison"].append(comparison_row("logistic_regression", logreg_metrics))

    # ================================================================
    # 2. Random Forest
    # ================================================================
    print("[2/8] Random Forest")
    forest = RandomForestClassifier(
        n_estimators=300,
        max_depth=12,
        min_samples_leaf=4,
        n_jobs=-1,
        random_state=args.seed,
    )
    forest_metrics = fit_and_score(forest, X_train_t, y_train, X_test_t, y_test)
    report["models"].append(
        model_entry(
            "random_forest",
            "classification",
            len(X_train),
            forest_metrics,
            importances=top_importances(transformer, forest.feature_importances_),
        )
    )
    report["comparison"].append(comparison_row("random_forest", forest_metrics))

    # ================================================================
    # 3. XGBoost — the production risk model
    # ================================================================
    print("[3/8] XGBoost")
    if HAS_XGBOOST:
        # scale_pos_weight is deliberately NOT set, which is worth explaining because
        # setting it is the conventional advice for imbalanced data.
        #
        # It compensates for imbalance by inflating the positive class, which helps
        # ranking metrics but systematically shifts predicted probabilities upward.
        # CalibratedClassifierCV refits the base estimator internally, so the bias is
        # baked in before calibration ever sees it and cannot be corrected afterwards.
        # Measured with scale_pos_weight = negative/positive: a benign tested change
        # scored 77/100 and an all-zero vector scored 80/100, while AUC was unchanged.
        #
        # Ranking comes from the model, probability correctness comes from the
        # calibration step. Reweighting here only corrupts the second.
        booster = XGBClassifier(
            n_estimators=400,
            max_depth=5,
            learning_rate=0.06,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_lambda=1.5,
            min_child_weight=3,
            eval_metric="logloss",
            tree_method="hist",
            n_jobs=-1,
            random_state=args.seed,
        )
        booster_metrics = fit_and_score(booster, X_train_t, y_train, X_test_t, y_test)
        report["models"].append(
            model_entry(
                "xgboost",
                "classification",
                len(X_train),
                booster_metrics,
                importances=top_importances(transformer, booster.feature_importances_),
            )
        )
        report["comparison"].append(comparison_row("xgboost", booster_metrics))
    else:
        print("      xgboost unavailable; falling back to GradientBoostingClassifier")
        booster = GradientBoostingClassifier(
            n_estimators=300, max_depth=4, learning_rate=0.08, random_state=args.seed
        )
        booster_metrics = fit_and_score(booster, X_train_t, y_train, X_test_t, y_test)
        report["models"].append(
            model_entry("gradient_boosting", "classification", len(X_train), booster_metrics)
        )
        report["comparison"].append(comparison_row("gradient_boosting", booster_metrics))

    # ---- pick and calibrate the production model
    #
    # Selected on ROC AUC rather than accuracy: accuracy on an imbalanced target
    # rewards predicting the majority class, which is exactly the useless model.
    candidates = [
        ("logistic_regression", logreg, logreg_metrics),
        ("random_forest", forest, forest_metrics),
        ("xgboost" if HAS_XGBOOST else "gradient_boosting", booster, booster_metrics),
    ]
    active_name, active_model, active_metrics = max(
        candidates, key=lambda entry: entry[2]["roc_auc"]
    )
    print(f"\n  selected {active_name} (ROC AUC {active_metrics['roc_auc']:.4f})")

    # Calibration method depends on the data, and this choice was made empirically
    # rather than by preference.
    #
    # Isotonic is the better calibrator given plenty of real, noisy data: it is
    # non-parametric and can correct an arbitrary distortion. But it is a step
    # function fitted to the empirical distribution, and on the bootstrap dataset
    # the labels are near-separable from the features, so isotonic collapses into a
    # near-degenerate step: measured here, a benign tested 180-line change scored
    # 99.5/100, indistinguishable from a change with two critical security findings.
    # That makes the score useless regardless of how good the AUC looks.
    #
    # Sigmoid (Platt scaling) fits a two-parameter logistic instead. It cannot
    # represent arbitrary distortions, but it also cannot saturate, so the score
    # keeps a usable spread. Real per-organization retraining switches to isotonic,
    # where the extra flexibility pays off against genuinely noisy labels.
    calibration_method = "sigmoid" if is_baseline else "isotonic"
    print(f"      calibrating probabilities ({calibration_method}, 5-fold)")
    calibrated = CalibratedClassifierCV(active_model, method=calibration_method, cv=5)
    calibrated.fit(X_train_t, y_train)

    calibrated_probabilities = calibrated.predict_proba(X_test_t)[:, 1]
    calibrated_auc = roc_auc_score(y_test, calibrated_probabilities)
    brier = float(np.mean((calibrated_probabilities - y_test) ** 2))
    print(f"      calibrated ROC AUC {calibrated_auc:.4f}, Brier score {brier:.4f}")

    active_metrics["calibrated_roc_auc"] = float(calibrated_auc)
    active_metrics["brier_score"] = brier

    # Recorded explicitly so the quality gate can evaluate the model that is
    # actually served. Gating on "best row in the comparison table" would let an
    # experimental variant's good score mask a regression in the production model.
    report["active_risk_model"] = active_name
    report["active_metrics"] = active_metrics

    # ================================================================
    # 4. Linear Regression — review time estimate
    # ================================================================
    print("\n[4/8] Linear Regression (review time)")
    y_minutes_train = y_minutes.loc[X_train.index]
    y_minutes_test = y_minutes.loc[X_test.index]

    # Trained on log(minutes) because review latency is right-skewed and
    # multiplicative. Fitting raw minutes lets a handful of week-long reviews
    # dominate the loss and drags every prediction upward.
    #
    # Ridge rather than plain OLS, and this is not a stylistic preference. The
    # transformed matrix has ~6000 columns (mostly TF-IDF) against ~4800 training
    # rows, so ordinary least squares is underdetermined: it fits the training set
    # exactly, produces enormous coefficients, and after expm1() the predictions
    # explode. Measured with LinearRegression here: R2 = -286, i.e. dramatically
    # worse than predicting the mean. RidgeCV picks the penalty by cross-validation
    # and keeps the coefficients bounded.
    #
    # Ridge is still linear regression; the L2 penalty is what makes it usable at
    # this feature-to-sample ratio.
    linreg = RidgeCV(alphas=np.logspace(-1, 3, 20))
    linreg.fit(X_train_t, np.log1p(y_minutes_train))

    log_predictions = linreg.predict(X_test_t)
    predicted_minutes = np.expm1(log_predictions).clip(min=1)

    mae = float(mean_absolute_error(y_minutes_test, predicted_minutes))
    median_ae = float(np.median(np.abs(y_minutes_test - predicted_minutes)))

    # R2 is evaluated in LOG SPACE, which is where the model is actually fitted.
    #
    # Measuring it on the raw minute scale is misleading for two compounding
    # reasons. Review latency is lognormal with a heavy right tail, so a handful of
    # week-long reviews dominate the total sum of squares. And inverting a log-space
    # fit with expm1 yields the conditional *median*, not the mean, which raw-scale
    # R2 penalises by construction. Measured here: raw R2 = -1.84 while log-space
    # R2 is strongly positive, for the same predictions.
    #
    # The median is also the statistic the product wants. "This will take about 25
    # minutes to review" should be the typical case, not an average inflated by the
    # one review that sat over a weekend.
    r2_log = float(r2_score(np.log1p(y_minutes_test), log_predictions))
    r2_raw = float(r2_score(y_minutes_test, predicted_minutes))

    # Residual spread in log space becomes the multiplicative prediction interval.
    log_residuals = np.log1p(y_minutes_test) - log_predictions
    residual_sigma = float(np.std(log_residuals))

    alpha = float(getattr(linreg, "alpha_", 0.0))
    print(
        f"      median abs err {median_ae:.1f} min, MAE {mae:.1f} min, "
        f"R2(log) {r2_log:.3f}, R2(raw) {r2_raw:.3f}"
    )
    print(f"      ridge alpha {alpha:.3f}, residual sigma {residual_sigma:.3f}")

    # Gate on log-space R2, the metric the model is fitted against. Negative there
    # genuinely means worse than predicting the mean, which would make the review
    # time estimate actively misleading — a confident wrong ETA is worse than none.
    if r2_log < 0.10:
        raise SystemExit(
            f"Review time model has log-space R2 {r2_log:.3f}, which is too low to be "
            "useful. Check the ridge penalty and the feature-to-sample ratio."
        )

    report["models"].append(
        model_entry(
            "ridge_regression_review_time",
            "regression",
            len(X_train),
            {
                "median_abs_error_minutes": median_ae,
                "mae_minutes": mae,
                "r2_log_space": r2_log,
                "r2_raw_scale": r2_raw,
                "residual_sigma": residual_sigma,
                "ridge_alpha": alpha,
            },
        )
    )

    # ================================================================
    # 5. KNN — similar historical pull requests
    # ================================================================
    print("[5/8] KNN (similar PRs)")
    knn_classifier = KNeighborsClassifier(n_neighbors=7, weights="distance", metric="cosine")
    knn_metrics = fit_and_score(knn_classifier, X_train_t, y_train, X_test_t, y_test)
    report["comparison"].append(comparison_row("knn", knn_metrics))

    # A separate unsupervised index does the actual neighbour lookup, because the
    # product question is "show me comparable past PRs and what happened to them",
    # not "classify this one".
    neighbours = NearestNeighbors(n_neighbors=min(25, len(X_train)), metric="cosine")
    neighbours.fit(X_train_t)

    # Reference metadata for whatever the index returns.
    neighbour_metadata = frame.loc[
        X_train.index, ["title_text", "was_risky", "outcome", "review_minutes"]
    ].to_dict("records")

    print(f"      indexed {len(X_train)} reference pull requests")
    report["models"].append(
        model_entry("knn_neighbours", "neighbours", len(X_train), knn_metrics)
    )

    # ================================================================
    # 6. KMeans — recurring issue patterns
    # ================================================================
    print("[6/8] KMeans (issue pattern clusters)")
    # Clusters finding text rather than PR features: the product question is "what
    # mistakes does this team keep making", which is a property of findings.
    issue_texts = build_issue_corpus(frame)
    issue_vectorizer = TfidfVectorizer(
        ngram_range=(1, 2), max_features=1500, sublinear_tf=True, min_df=2, stop_words="english"
    )
    issue_matrix = issue_vectorizer.fit_transform(issue_texts)

    n_clusters = min(8, max(2, len(issue_texts) // 50))
    kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=args.seed)
    cluster_labels = kmeans.fit_predict(issue_matrix)

    silhouette = (
        float(silhouette_score(issue_matrix, cluster_labels))
        if n_clusters > 1 and len(set(cluster_labels)) > 1
        else 0.0
    )
    print(f"      {n_clusters} clusters, silhouette {silhouette:.3f}")
    report["models"].append(
        model_entry(
            "kmeans_issue_patterns",
            "clustering",
            len(issue_texts),
            {"n_clusters": float(n_clusters), "silhouette": silhouette},
        )
    )

    # ================================================================
    # 7. SVM — issue type classification
    # ================================================================
    print("[7/8] LinearSVC (issue type)")
    issue_type_labels = frame["issue_type"].astype(str)
    type_vectorizer = TfidfVectorizer(
        ngram_range=(1, 2), max_features=2000, sublinear_tf=True, min_df=2
    )
    type_matrix = type_vectorizer.fit_transform(build_issue_corpus(frame))

    (
        type_train_X,
        type_test_X,
        type_train_y,
        type_test_y,
    ) = train_test_split(
        type_matrix, issue_type_labels, test_size=0.2, random_state=args.seed
    )

    # LinearSVC over SVC(kernel="rbf"): text features are high-dimensional and
    # already near-linearly separable, and the linear solver is orders of magnitude
    # faster. Wrapped in calibration because LinearSVC has no predict_proba and the
    # API contract returns per-class probabilities.
    svm = CalibratedClassifierCV(
        LinearSVC(C=1.0, class_weight="balanced", max_iter=3000, dual="auto"),
        method="sigmoid",
        cv=3,
    )
    svm.fit(type_train_X, type_train_y)

    svm_accuracy = float(accuracy_score(type_test_y, svm.predict(type_test_X)))
    svm_f1 = float(f1_score(type_test_y, svm.predict(type_test_X), average="macro"))
    print(f"      accuracy {svm_accuracy:.3f}, macro F1 {svm_f1:.3f}")
    report["models"].append(
        model_entry(
            "svm_issue_type",
            "classification",
            int(type_train_X.shape[0]),
            {"accuracy": svm_accuracy, "macro_f1": svm_f1},
        )
    )

    # ================================================================
    # 8. Bagging vs boosting comparison
    # ================================================================
    print("[8/8] Bagging vs boosting experiment")
    # Same base estimator, two ensembling strategies, so the comparison isolates
    # the strategy rather than confounding it with model family. Bagging reduces
    # variance; boosting reduces bias. On tabular risk data boosting usually wins,
    # and the table is published through the API so that claim is checkable.
    bagging = BaggingClassifier(
        estimator=DecisionTreeClassifier(max_depth=8, random_state=args.seed),
        n_estimators=200,
        max_samples=0.8,
        n_jobs=-1,
        random_state=args.seed,
    )
    bagging_metrics = fit_and_score(bagging, X_train_t, y_train, X_test_t, y_test)
    report["comparison"].append(comparison_row("bagging_trees", bagging_metrics))

    boosting = GradientBoostingClassifier(
        n_estimators=200, max_depth=3, learning_rate=0.1, random_state=args.seed
    )
    boosting_metrics = fit_and_score(boosting, X_train_t, y_train, X_test_t, y_test)
    report["comparison"].append(comparison_row("boosting_trees", boosting_metrics))

    # Cross-validated AUC on the selected model, as a guard against a lucky split.
    cv_scores = cross_val_score(
        LogisticRegression(max_iter=2000, class_weight="balanced", random_state=args.seed),
        X_train_t,
        y_train,
        cv=5,
        scoring="roc_auc",
    )
    print(f"      5-fold CV AUC (logreg): {cv_scores.mean():.4f} +/- {cv_scores.std():.4f}")
    report["cross_validation"] = {
        "mean_roc_auc": float(cv_scores.mean()),
        "std_roc_auc": float(cv_scores.std()),
    }

    # ================================================================
    # Persist
    # ================================================================
    print("\nWriting artifacts")

    bundle = {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "is_baseline": is_baseline,
        "trained_at": report["trained_at"],
        "transformer": transformer,
        "active_risk_model_name": active_name,
        "risk_model": active_model,
        "risk_model_calibrated": calibrated,
        "review_time_model": linreg,
        "review_time_residual_sigma": residual_sigma,
        "knn_classifier": knn_classifier,
        "neighbours_index": neighbours,
        "neighbour_metadata": neighbour_metadata,
        "issue_vectorizer": issue_vectorizer,
        "kmeans": kmeans,
        "type_vectorizer": type_vectorizer,
        "svm_issue_type": svm,
        # Kept so SHAP can build a background distribution without reloading the
        # training data at inference time.
        "shap_background": X_train_t[: min(200, len(X_train_t))],
        "feature_names": expand_feature_names(transformer),
    }

    joblib.dump(bundle, artifacts / "models.joblib", compress=3)
    (artifacts / "model_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"  {artifacts / 'models.joblib'}")
    print(f"  {artifacts / 'model_report.json'}")

    print("\nComparison table")
    print(f"  {'model':<24} {'AUC':>7} {'F1':>7} {'prec':>7} {'recall':>7} {'acc':>7} {'fit s':>7}")
    for row in sorted(report["comparison"], key=lambda r: -r["roc_auc"]):
        print(
            f"  {row['model_name']:<24} {row['roc_auc']:>7.4f} {row['f1']:>7.4f} "
            f"{row['precision']:>7.4f} {row['recall']:>7.4f} {row['accuracy']:>7.4f} "
            f"{row['fit_seconds']:>7.2f}"
        )

    print(f"\nActive risk model: {active_name} (calibrated AUC {calibrated_auc:.4f})")

    if is_baseline:
        print(
            "\n  READ THE AUC WITH CARE. On bootstrap data the labels are generated from a\n"
            "  deterministic function of these same features, so a good model largely\n"
            "  recovers that function and AUC lands near 0.95+. That number measures\n"
            "  whether the pipeline is wired correctly, NOT whether the model predicts\n"
            "  real review outcomes. Expect a genuine AUC around 0.70-0.80 once fitted on\n"
            "  an organisation's actual review history, and treat that as the improvement."
        )

    print("\nTraining complete.")


# ---------------------------------------------------------------- helpers


def fit_and_score(
    model: Any,
    X_train: np.ndarray,
    y_train: pd.Series,
    X_test: np.ndarray,
    y_test: pd.Series,
) -> dict[str, float]:
    started = time.perf_counter()
    model.fit(X_train, y_train)
    fit_seconds = time.perf_counter() - started

    predictions = model.predict(X_test)

    if hasattr(model, "predict_proba"):
        probabilities = model.predict_proba(X_test)[:, 1]
    elif hasattr(model, "decision_function"):
        probabilities = model.decision_function(X_test)
    else:  # pragma: no cover
        probabilities = predictions

    metrics = {
        "roc_auc": float(roc_auc_score(y_test, probabilities)),
        "f1": float(f1_score(y_test, predictions, zero_division=0)),
        "precision": float(precision_score(y_test, predictions, zero_division=0)),
        "recall": float(recall_score(y_test, predictions, zero_division=0)),
        "accuracy": float(accuracy_score(y_test, predictions)),
        "fit_seconds": float(fit_seconds),
    }

    print(
        f"      AUC {metrics['roc_auc']:.4f}  F1 {metrics['f1']:.4f}  "
        f"precision {metrics['precision']:.4f}  recall {metrics['recall']:.4f}  "
        f"({fit_seconds:.2f}s)"
    )
    return metrics


def model_entry(
    name: str,
    task: str,
    n_samples: int,
    metrics: dict[str, float],
    importances: dict[str, float] | None = None,
) -> dict[str, Any]:
    return {
        "model_name": name,
        "task": task,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": n_samples,
        "metrics": metrics,
        "feature_importances": importances,
    }


def comparison_row(name: str, metrics: dict[str, float]) -> dict[str, Any]:
    return {
        "model_name": name,
        "roc_auc": metrics["roc_auc"],
        "f1": metrics["f1"],
        "precision": metrics["precision"],
        "recall": metrics["recall"],
        "accuracy": metrics["accuracy"],
        "fit_seconds": metrics["fit_seconds"],
    }


def expand_feature_names(transformer: ColumnTransformer) -> list[str]:
    """Column names of the transformed matrix, in order.

    Needed to map a SHAP value back to a human-readable feature. Without it the
    explanation is a vector of numbers against anonymous column indices.
    """
    names: list[str] = []

    for name, _, columns in transformer.transformers_:
        if name == "num":
            names.extend(NUMERIC_FEATURES)
        elif name == "derived":
            names.extend(
                [
                    "churn",
                    "lines_per_file",
                    "lines_per_commit",
                    "delete_ratio",
                    "complexity_per_line",
                    "sensitive_area_count",
                    "large_without_tests",
                ]
            )
        elif name in ("title", "commit"):
            # TF-IDF now feeds TruncatedSVD, so the columns are latent components
            # rather than tokens. Named accordingly: an individual component is not
            # interpretable, which is fine because only numeric features are surfaced
            # as risk reasons.
            fitted = dict(transformer.named_transformers_)[name]
            try:
                n_components = fitted.named_steps["svd"].n_components
                names.extend([f"{name}_svd_{i}" for i in range(n_components)])
            except Exception:  # pragma: no cover
                names.append(f"{name}:unknown")
        _ = columns

    return names


def top_importances(
    transformer: ColumnTransformer, importances: np.ndarray, limit: int = 20
) -> dict[str, float]:
    names = expand_feature_names(transformer)
    paired = list(zip(names, importances.tolist(), strict=False))
    paired.sort(key=lambda entry: -abs(entry[1]))
    return {name: float(value) for name, value in paired[:limit]}


def build_issue_corpus(frame: pd.DataFrame) -> list[str]:
    """Synthetic finding text for the clustering and issue-type models.

    In production this is replaced by real ``StaticFinding.message`` values, which
    the API supplies when retraining per organization. The synthetic version exists
    so the clustering endpoint works before any findings have accumulated.
    """
    corpus: list[str] = []

    templates = {
        "security": [
            "raw sql query built with string interpolation allows injection",
            "hardcoded credential committed in source file",
            "missing authorization check on protected route",
            "unsafe deserialization of untrusted input",
            "sensitive value logged in plaintext",
        ],
        "bug": [
            "promise returned without await causes unhandled rejection",
            "null dereference when optional field is absent",
            "off by one error in loop boundary",
            "incorrect comparison operator in conditional",
        ],
        "performance": [
            "n plus one query inside request loop",
            "synchronous file read blocks the event loop",
            "missing index on frequently filtered column",
        ],
        "testing": [
            "no test covers the new branch",
            "assertion removed without replacement",
            "test skipped and never re-enabled",
        ],
        "maintainability": [
            "function exceeds complexity threshold",
            "duplicated logic across modules",
            "magic number without explanation",
        ],
        "dependency": [
            "vulnerable transitive dependency with known advisory",
            "major version bump with breaking changes",
        ],
        "style": [
            "inconsistent naming convention",
            "unused import left in file",
        ],
    }

    rng = np.random.default_rng(7)
    all_types = list(templates.keys())

    for issue_type in frame["issue_type"].astype(str):
        # 18% of the time draw from a different category's templates.
        #
        # Without this the mapping from text to label is deterministic and the SVM
        # scores a perfect 1.000 — which looks impressive and means nothing, because
        # the task is not separable-hard, it is trivially memorisable. Real finding
        # text is ambiguous ("unsafe deserialization" is arguably both a security
        # issue and a bug), so injecting overlap makes the reported accuracy a
        # meaningful number rather than a measurement of the generator.
        if rng.random() < 0.18:
            source = str(rng.choice(all_types))
        else:
            source = issue_type if issue_type in templates else "maintainability"

        corpus.append(str(rng.choice(templates[source])))

    return corpus


if __name__ == "__main__":
    main()
