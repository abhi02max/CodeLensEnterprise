"""Model quality gate.

Run in CI after training. Fails the build when the selected model's ROC AUC falls
below an agreed floor.

This exists because unit tests do not catch model regression. Every test can pass
while a change to feature engineering, a dependency bump, or a bad hyperparameter
quietly drops AUC from 0.88 to 0.61 — and nothing else in the pipeline notices. The
gate turns that into a red build.

    python scripts/check_model_quality.py --min-auc 0.75
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--min-auc", type=float, default=0.75)
    parser.add_argument("--min-f1", type=float, default=0.50)
    parser.add_argument(
        "--max-brier",
        type=float,
        default=0.25,
        help="Calibration quality; lower is better. 0.25 is the no-skill baseline.",
    )
    parser.add_argument("--report", type=str, default="artifacts/model_report.json")
    args = parser.parse_args()

    report_path = Path(__file__).resolve().parents[1] / args.report

    if not report_path.exists():
        print(f"FAIL  no model report at {report_path}. Run scripts/train.py first.")
        return 1

    report = json.loads(report_path.read_text(encoding="utf-8"))
    failures: list[str] = []

    # Gate on the model that is actually served, not the best row in the comparison
    # table. The comparison includes experimental variants (bagging, boosting, KNN)
    # which are evaluated but never deployed; letting one of those satisfy the gate
    # would allow the production model to regress unnoticed.
    active_name = report.get("active_risk_model")
    active_metrics: dict[str, float] = report.get("active_metrics", {})

    if not active_name or not active_metrics:
        print(
            "FAIL  report does not record an active_risk_model. Retrain with the "
            "current scripts/train.py, which records the deployed model explicitly."
        )
        return 1

    print(f"Model quality gate  (report: {report_path.name})")
    print(f"  active model   : {active_name}   <- the model actually served")
    print(f"  ROC AUC        : {active_metrics['roc_auc']:.4f}   (floor {args.min_auc})")
    print(f"  F1             : {active_metrics['f1']:.4f}   (floor {args.min_f1})")

    if active_metrics["roc_auc"] < args.min_auc:
        failures.append(
            f"Active model ROC AUC {active_metrics['roc_auc']:.4f} is below the floor "
            f"of {args.min_auc}"
        )

    if active_metrics["f1"] < args.min_f1:
        failures.append(
            f"Active model F1 {active_metrics['f1']:.4f} is below the floor of {args.min_f1}"
        )

    # Calibration matters as much as ranking. A model that ranks correctly but
    # reports 0.9 for pull requests that need changes 40% of the time makes the
    # policy risk gate meaningless, because the threshold no longer means anything.
    if "brier_score" in active_metrics:
        brier = active_metrics["brier_score"]
        print(f"  Brier score    : {brier:.4f}   (ceiling {args.max_brier})")
        if brier > args.max_brier:
            failures.append(
                f"Brier score {brier:.4f} exceeds the ceiling of {args.max_brier}; "
                "probabilities are poorly calibrated"
            )

    # Informational: how the deployed model compares to what was evaluated. A
    # production model far below the best experimental result is a signal that the
    # selection logic or the calibration step needs attention.
    comparison: list[dict[str, float]] = report.get("comparison", [])
    if comparison:
        best = max(comparison, key=lambda row: row["roc_auc"])
        if best["model_name"] != active_name:
            print(
                f"  note           : best evaluated was {best['model_name']} "
                f"at {best['roc_auc']:.4f} (experimental, not deployed)"
            )

    cv = report.get("cross_validation")
    if cv:
        print(
            f"  5-fold CV AUC  : {cv['mean_roc_auc']:.4f} +/- {cv['std_roc_auc']:.4f}"
        )
        # High variance across folds means the headline number is a coin flip.
        if cv["std_roc_auc"] > 0.08:
            failures.append(
                f"Cross-validation AUC standard deviation {cv['std_roc_auc']:.4f} is high; "
                "the model is unstable across folds"
            )

    if report.get("is_baseline"):
        print("\n  NOTE: these artifacts were trained on synthetic bootstrap data and are")
        print("        tagged is_baseline=True. The gate verifies the pipeline is sound,")
        print("        not that the model has learned anything about a real team.")

    if failures:
        print("\nFAIL")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nPASS  all quality thresholds met")
    return 0


if __name__ == "__main__":
    sys.exit(main())
