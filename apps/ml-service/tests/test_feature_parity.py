"""Cross-language feature contract guard.

The ML feature vector is defined twice: once in TypeScript
(``packages/shared/src/ml-features.ts``) where it is built, and once in Python
(``app/features.py``) where it is consumed. Those two lists must be identical, in
the same order.

A mismatch does not raise anywhere. The ``ColumnTransformer`` happily accepts a
matrix whose columns have shifted and produces confident, wrong predictions —
``lines_deleted`` scored as though it were ``lines_added``. No amount of testing on
either side independently catches it, because each side is internally consistent.

So this test parses the TypeScript source and compares. It is the only thing
standing between a one-line reordering and silently corrupted risk scores.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features import (  # noqa: E402
    BINARY_FEATURES,
    FEATURE_LABELS,
    FEATURE_SCHEMA_VERSION,
    NUMERIC_FEATURES,
    TEXT_FEATURES,
    empty_features,
    to_dataframe,
    validate_features,
)

SHARED_ML_FEATURES = (
    Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "ml-features.ts"
)


def parse_typescript_list(source: str, const_name: str) -> list[str]:
    """Extract a string-literal array from a TypeScript const declaration."""
    pattern = rf"export const {const_name} = \[(.*?)\] as const;"
    match = re.search(pattern, source, re.DOTALL)

    if not match:
        raise AssertionError(f"Could not find {const_name} in {SHARED_ML_FEATURES.name}")

    return re.findall(r"'([^']+)'", match.group(1))


@pytest.fixture(scope="module")
def typescript_source() -> str:
    if not SHARED_ML_FEATURES.exists():
        pytest.skip(f"TypeScript contract not found at {SHARED_ML_FEATURES}")
    return SHARED_ML_FEATURES.read_text(encoding="utf-8")


def test_numeric_feature_names_and_order_match(typescript_source: str) -> None:
    ts_features = parse_typescript_list(typescript_source, "NUMERIC_FEATURES")

    assert ts_features == NUMERIC_FEATURES, (
        "NUMERIC_FEATURES has drifted between TypeScript and Python.\n"
        f"  TypeScript: {ts_features}\n"
        f"  Python    : {NUMERIC_FEATURES}\n"
        "Column order is load-bearing: a mismatch silently feeds each value into the "
        "wrong model column. Fix both sides, bump FEATURE_SCHEMA_VERSION, and retrain."
    )


def test_text_feature_names_match(typescript_source: str) -> None:
    ts_text = parse_typescript_list(typescript_source, "TEXT_FEATURES")
    assert ts_text == TEXT_FEATURES


def test_feature_schema_version_matches(typescript_source: str) -> None:
    match = re.search(r"export const FEATURE_SCHEMA_VERSION = (\d+);", typescript_source)
    assert match, "FEATURE_SCHEMA_VERSION not found in the TypeScript contract"

    ts_version = int(match.group(1))
    assert ts_version == FEATURE_SCHEMA_VERSION, (
        f"Feature schema version mismatch: TypeScript v{ts_version}, "
        f"Python v{FEATURE_SCHEMA_VERSION}. Both sides must be bumped together."
    )


def test_every_numeric_feature_has_a_label() -> None:
    """A feature without a label cannot be explained to a reviewer."""
    missing = [name for name in NUMERIC_FEATURES if name not in FEATURE_LABELS]
    assert not missing, f"Features missing a display label: {missing}"


def test_empty_features_covers_every_column() -> None:
    features = empty_features()
    for name in NUMERIC_FEATURES + TEXT_FEATURES:
        assert name in features, f"empty_features() is missing {name}"


def test_to_dataframe_fills_missing_columns_in_canonical_order() -> None:
    """A caller on an older schema should degrade, not fail."""
    frame = to_dataframe([{"lines_added": 10, "title_text": "fix typo"}])

    assert list(frame.columns) == NUMERIC_FEATURES + TEXT_FEATURES
    assert frame.iloc[0]["lines_added"] == 10
    assert frame.iloc[0]["files_changed"] == 0
    assert frame.iloc[0]["commit_text"] == ""


def test_to_dataframe_drops_unknown_columns() -> None:
    """An extra field must not shift column positions."""
    frame = to_dataframe([{"lines_added": 5, "some_future_feature": 99}])

    assert "some_future_feature" not in frame.columns
    assert list(frame.columns) == NUMERIC_FEATURES + TEXT_FEATURES


def test_binary_features_are_a_subset_of_numeric() -> None:
    assert BINARY_FEATURES.issubset(set(NUMERIC_FEATURES))


def test_validate_features_flags_non_binary_flag_values() -> None:
    problems = validate_features({"auth_file_changed": 3})
    assert any("auth_file_changed" in problem for problem in problems)


def test_validate_features_allows_negative_complexity_delta() -> None:
    """A refactor that simplifies code is legitimate and must not be flagged."""
    problems = validate_features({"complexity_delta": -42})
    assert problems == []


def test_validate_features_flags_negative_counts() -> None:
    problems = validate_features({"lines_added": -1})
    assert any("lines_added" in problem for problem in problems)
