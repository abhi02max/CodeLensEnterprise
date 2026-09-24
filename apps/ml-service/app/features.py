"""Feature contract.

This module is the Python half of a cross-language contract. ``NUMERIC_FEATURES``
must match ``NUMERIC_FEATURES`` in ``packages/shared/src/ml-features.ts`` exactly,
in the same order.

Order matters because the ``ColumnTransformer`` is constructed from this list. A
mismatch does not raise: it silently feeds ``lines_deleted`` into the column the
model learned as ``lines_added`` and produces confident nonsense. That failure mode
is why ``tests/test_feature_parity.py`` parses the TypeScript file and asserts the
two lists are identical.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

FEATURE_SCHEMA_VERSION = 1

# Canonical order. Mirrors packages/shared/src/ml-features.ts.
NUMERIC_FEATURES: list[str] = [
    "lines_added",
    "lines_deleted",
    "files_changed",
    "number_of_commits",
    "complexity_delta",
    "security_findings_count",
    "dependency_changed",
    "test_files_changed",
    "auth_file_changed",
    "database_file_changed",
    "config_file_changed",
    "payment_file_changed",
    "previous_risky_file_count",
]

TEXT_FEATURES: list[str] = ["title_text", "commit_text"]

ALL_FEATURES: list[str] = NUMERIC_FEATURES + TEXT_FEATURES

# Human labels, mirroring FEATURE_LABELS on the TypeScript side so SHAP output can
# be rendered without the API needing its own translation table.
FEATURE_LABELS: dict[str, str] = {
    "lines_added": "Lines added",
    "lines_deleted": "Lines deleted",
    "files_changed": "Files changed",
    "number_of_commits": "Commits",
    "complexity_delta": "Complexity delta",
    "security_findings_count": "Security findings",
    "dependency_changed": "Dependencies changed",
    "test_files_changed": "Tests changed",
    "auth_file_changed": "Auth code changed",
    "database_file_changed": "Database code changed",
    "config_file_changed": "Config changed",
    "payment_file_changed": "Payment code changed",
    "previous_risky_file_count": "Historically risky files",
}

# Plain-language explanation per feature and direction. Used to turn a SHAP value
# into something a reviewer can act on: "+0.31 for security_findings_count" means
# nothing on its own.
FEATURE_EXPLANATIONS: dict[str, dict[str, str]] = {
    "lines_added": {
        "up": "The change is large enough that a reviewer is likely to miss something.",
        "down": "The change is small enough to review carefully in one sitting.",
    },
    "lines_deleted": {
        "up": "Substantial deletions can remove behaviour or safeguards that callers rely on.",
        "down": "Little was removed, so existing behaviour is largely intact.",
    },
    "files_changed": {
        "up": "Touching many files spreads the change across more review surface.",
        "down": "The change is contained to a small number of files.",
    },
    "number_of_commits": {
        "up": "A high commit count often indicates an unsquashed or meandering branch.",
        "down": "A tight commit history suggests a focused change.",
    },
    "complexity_delta": {
        "up": "The change adds branching logic, which is where defects concentrate.",
        "down": "The change reduces branching complexity, which lowers defect risk.",
    },
    "security_findings_count": {
        "up": "Static analysis flagged security issues on lines this change touched.",
        "down": "No security findings were raised on the touched lines.",
    },
    "dependency_changed": {
        "up": "A dependency manifest changed, introducing supply-chain surface.",
        "down": "No dependency changes, so no new third-party surface.",
    },
    "test_files_changed": {
        "up": "No test file was modified despite behaviour changing.",
        "down": "Tests were updated alongside the code, which is a strong quality signal.",
    },
    "auth_file_changed": {
        "up": "Authentication or authorization code changed, where defects are security incidents.",
        "down": "No authentication code was touched.",
    },
    "database_file_changed": {
        "up": "Schema, migration or data access code changed, which is hard to roll back.",
        "down": "No database layer changes.",
    },
    "config_file_changed": {
        "up": "Configuration changed, which can affect every environment at once.",
        "down": "No configuration changes.",
    },
    "payment_file_changed": {
        "up": "Billing or payment code changed, where defects have direct financial impact.",
        "down": "No payment code was touched.",
    },
    "previous_risky_file_count": {
        "up": "Files in this change have previously appeared in reverts, hotfixes or rejected reviews.",
        "down": "The files in this change have a clean history in this repository.",
    },
}

# Features that are strictly 0/1. Validated on the way in so a caller sending a
# count where a flag is expected fails loudly rather than skewing a prediction.
BINARY_FEATURES: set[str] = {
    "dependency_changed",
    "test_files_changed",
    "auth_file_changed",
    "database_file_changed",
    "config_file_changed",
    "payment_file_changed",
}


def empty_features() -> dict[str, float | str]:
    """Zeroed feature vector, used as a fallback and as a test fixture base."""
    features: dict[str, float | str] = {name: 0 for name in NUMERIC_FEATURES}
    features["title_text"] = ""
    features["commit_text"] = ""
    return features


def to_dataframe(records: list[dict[str, object]]) -> pd.DataFrame:
    """Build a DataFrame with every expected column, in canonical order.

    Missing columns are filled rather than raising: a caller on an older feature
    schema should degrade to a zeroed column, not fail the whole review. Extra
    columns are dropped so an added field cannot shift positions.
    """
    frame = pd.DataFrame(records)

    for name in NUMERIC_FEATURES:
        if name not in frame.columns:
            frame[name] = 0
        frame[name] = pd.to_numeric(frame[name], errors="coerce").fillna(0)

    for name in TEXT_FEATURES:
        if name not in frame.columns:
            frame[name] = ""
        frame[name] = frame[name].fillna("").astype(str)

    return frame[ALL_FEATURES]


def numeric_matrix(frame: pd.DataFrame) -> np.ndarray:
    """Numeric columns only, in canonical order."""
    return frame[NUMERIC_FEATURES].to_numpy(dtype=float)


def derived_ratios(frame: pd.DataFrame) -> pd.DataFrame:
    """Ratio features derived from the raw counts.

    Deliberately computed here rather than carried across the service boundary:
    they are pure functions of existing columns, so deriving them keeps the wire
    contract small and guarantees train and serve compute them identically.

    ``churn`` and ``test_ratio`` carry signal the raw counts do not. A 500-line
    change with 400 lines of tests is a very different risk from a 500-line change
    with none, but ``lines_added`` alone cannot express that.
    """
    derived = pd.DataFrame(index=frame.index)

    total_lines = frame["lines_added"] + frame["lines_deleted"]

    derived["churn"] = total_lines
    derived["lines_per_file"] = total_lines / frame["files_changed"].clip(lower=1)
    derived["lines_per_commit"] = total_lines / frame["number_of_commits"].clip(lower=1)
    derived["delete_ratio"] = frame["lines_deleted"] / total_lines.clip(lower=1)
    derived["complexity_per_line"] = frame["complexity_delta"] / total_lines.clip(lower=1)

    # Count of sensitive areas touched. Two sensitive areas in one change is worse
    # than the sum of the individual flags suggests.
    derived["sensitive_area_count"] = (
        frame["auth_file_changed"]
        + frame["database_file_changed"]
        + frame["payment_file_changed"]
        + frame["config_file_changed"]
    )

    # Large change with no tests: the single most reliable heuristic signal.
    derived["large_without_tests"] = (
        (total_lines > 200) & (frame["test_files_changed"] == 0)
    ).astype(int)

    return derived


def validate_features(record: dict[str, object]) -> list[str]:
    """Return human-readable problems with a feature record.

    Advisory rather than fatal. A slightly malformed vector still produces a
    usable prediction, and refusing to score it would take the risk panel down
    over a rounding error. Warnings are surfaced in the response so a persistent
    contract drift is visible rather than silent.
    """
    problems: list[str] = []

    for name in BINARY_FEATURES:
        value = record.get(name)
        if value is not None and value not in (0, 1, True, False):
            problems.append(f"{name} should be 0 or 1 but received {value!r}")

    for name in NUMERIC_FEATURES:
        if name == "complexity_delta":
            # Legitimately negative: a refactor that simplifies code.
            continue
        value = record.get(name)
        if isinstance(value, (int, float)) and value < 0:
            problems.append(f"{name} should not be negative but received {value!r}")

    return problems
