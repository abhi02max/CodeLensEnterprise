"""Bootstrap dataset generator.

THE HONEST FRAMING, because this matters more than the code:

No organization has labelled pull-request history on the day they install
CodeLens. Something has to produce a risk score before that data exists, and the
options are a hardcoded rule set, nothing at all, or a model fitted on synthetic
data whose labelling rule is written down and auditable.

This takes the third option, and every artifact it produces is tagged
``modelVersion="bootstrap-v1"`` and ``is_baseline=True`` so the UI can label it as
a heuristic baseline rather than passing it off as learned insight. A synthetic
model cannot discover anything its own label function does not already encode.

What it *is* good for:
  - exercising the full inference path end to end before real data arrives
  - giving reviewers a calibrated-looking score instead of a blank panel
  - serving as the control that per-organization retraining must beat

The label rule below is the same heuristic a thoughtful staff engineer would
apply, expressed as weighted log-odds. Real labels replace it as soon as an
organization accumulates 200 reviewed pull requests (``ML_MIN_SAMPLES_FOR_ORG_MODEL``),
collected passively from CHANGES_REQUESTED verdicts, reverts, and hotfixes that
touch the same files within seven days.

    python scripts/generate_dataset.py --samples 6000 --seed 42
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features import NUMERIC_FEATURES  # noqa: E402

# Vocabulary for synthesizing PR titles and commit messages. Split by whether the
# phrasing correlates with risk in practice, so TF-IDF has genuine signal to find
# rather than noise.
LOW_RISK_TITLE_PARTS = [
    "fix typo in", "update documentation for", "add test coverage for",
    "bump", "rename", "extract helper from", "add jsdoc to",
    "improve error message in", "add logging to", "reformat",
    "remove unused import from", "add null check to", "clarify comment in",
]

HIGH_RISK_TITLE_PARTS = [
    "refactor", "rewrite", "migrate", "remove validation from",
    "skip", "disable", "bypass", "hotfix", "temporarily allow",
    "force", "override", "patch around", "quick fix for",
    "revert", "workaround for", "unblock",
]

NEUTRAL_TITLE_PARTS = [
    "add", "implement", "support", "introduce", "wire up",
    "handle", "expose", "enable", "integrate",
]

SUBJECTS = [
    "refund service", "auth middleware", "payment webhook", "user repository",
    "session handling", "rate limiter", "ledger writer", "invoice generator",
    "permission checks", "database migration", "config loader", "token refresh",
    "checkout flow", "audit logging", "email sender", "search index",
    "cache layer", "job queue", "api gateway", "feature flags",
]

COMMIT_PREFIXES = ["feat", "fix", "chore", "refactor", "test", "docs", "perf", "build"]

RISKY_COMMIT_PHRASES = [
    "wip", "temporarily", "not sure why this works", "quick fix", "revert previous",
    "try again", "fix build", "fix tests", "another attempt", "hack",
    "TODO clean this up", "force push", "disable check", "comment out",
]


def generate(n_samples: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows: list[dict[str, object]] = []

    for _ in range(n_samples):
        # ---- size, drawn from a lognormal.
        #
        # Real PR sizes are heavily right-skewed: most are small, a few are
        # enormous. A uniform distribution would teach the model that a 400-line
        # change is ordinary, which it is not.
        lines_added = int(rng.lognormal(mean=3.4, sigma=1.35))
        lines_added = min(lines_added, 5000)

        delete_ratio = rng.beta(2, 4)
        lines_deleted = int(lines_added * delete_ratio)

        total_lines = max(lines_added + lines_deleted, 1)

        # Files scale sublinearly with lines: bigger changes concentrate.
        files_changed = max(1, int(rng.gamma(2.0, total_lines**0.45 / 3)))
        files_changed = min(files_changed, 200)

        number_of_commits = max(1, int(rng.gamma(1.8, 1 + total_lines / 300)))
        number_of_commits = min(number_of_commits, 80)

        # Complexity roughly tracks added lines, but can be negative for a
        # simplifying refactor.
        complexity_delta = float(
            rng.normal(loc=lines_added * 0.045, scale=max(2.0, lines_added * 0.05))
        )

        # ---- sensitive-area flags
        auth_file_changed = int(rng.random() < 0.11)
        database_file_changed = int(rng.random() < 0.17)
        config_file_changed = int(rng.random() < 0.20)
        payment_file_changed = int(rng.random() < 0.08)
        dependency_changed = int(rng.random() < 0.14)

        # ---- tests
        #
        # Probability of including tests rises with size (people test big changes
        # more often) but stays well short of certain.
        test_probability = min(0.78, 0.22 + (total_lines / 1400))
        test_files_changed = int(rng.random() < test_probability)

        # ---- security findings
        #
        # Correlated with auth/payment surface and with size, because more code
        # means more chances to trip a rule.
        finding_rate = (
            0.05
            + 0.22 * auth_file_changed
            + 0.16 * payment_file_changed
            + 0.10 * dependency_changed
            + min(0.25, total_lines / 3000)
        )
        security_findings_count = int(rng.poisson(finding_rate * 2.2))

        # ---- history
        #
        # Zero-inflated: most PRs touch no historically troublesome file, but when
        # they do it tends to be more than one.
        if rng.random() < 0.72:
            previous_risky_file_count = 0
        else:
            previous_risky_file_count = min(files_changed, 1 + int(rng.poisson(1.4)))

        record: dict[str, object] = {
            "lines_added": lines_added,
            "lines_deleted": lines_deleted,
            "files_changed": files_changed,
            "number_of_commits": number_of_commits,
            "complexity_delta": round(complexity_delta, 2),
            "security_findings_count": security_findings_count,
            "dependency_changed": dependency_changed,
            "test_files_changed": test_files_changed,
            "auth_file_changed": auth_file_changed,
            "database_file_changed": database_file_changed,
            "config_file_changed": config_file_changed,
            "payment_file_changed": payment_file_changed,
            "previous_risky_file_count": previous_risky_file_count,
        }

        # ---- label, then text conditioned on it
        #
        # Text is generated *after* the label so that risky PRs genuinely tend to
        # carry risky phrasing. Generating text independently would leave TF-IDF
        # with nothing to learn, and the text features would look useless for
        # reasons that have nothing to do with reality.
        risk_logit = compute_risk_logit(record)
        probability = 1 / (1 + np.exp(-risk_logit))
        is_risky = int(rng.random() < probability)

        record["title_text"] = synthesize_title(rng, is_risky)
        record["commit_text"] = synthesize_commits(rng, is_risky, number_of_commits)
        record["was_risky"] = is_risky
        record["review_minutes"] = synthesize_review_minutes(rng, record, is_risky)
        record["issue_type"] = synthesize_issue_type(rng, record)
        record["outcome"] = (
            "CHANGES_REQUESTED" if is_risky and rng.random() < 0.75
            else "REVERTED" if is_risky
            else "APPROVED"
        )

        rows.append(record)

    return pd.DataFrame(rows)


def compute_risk_logit(record: dict[str, object]) -> float:
    """The documented labelling heuristic.

    Weights are in log-odds and were chosen to reflect how a senior reviewer
    actually weighs these signals, not fitted to anything. They are stated
    explicitly so the bootstrap model's behaviour is fully auditable: anything it
    predicts traces back to a coefficient on this list.

    The largest weights go to *evidence* (security findings) and to *absent
    safeguards* (no tests on a large change), not to raw size. Size is a weak
    proxy; a 600-line mechanical rename is far safer than a 40-line change to
    token validation, and the weights encode that ordering.
    """
    total_lines = float(record["lines_added"]) + float(record["lines_deleted"])  # type: ignore[arg-type]

    logit = -2.4  # base rate: most pull requests are fine

    # Evidence carries the most weight.
    logit += 0.42 * float(record["security_findings_count"])  # type: ignore[arg-type]

    # Sensitive surfaces.
    logit += 0.85 * float(record["auth_file_changed"])  # type: ignore[arg-type]
    logit += 0.95 * float(record["payment_file_changed"])  # type: ignore[arg-type]
    logit += 0.45 * float(record["database_file_changed"])  # type: ignore[arg-type]
    logit += 0.30 * float(record["config_file_changed"])  # type: ignore[arg-type]
    logit += 0.35 * float(record["dependency_changed"])  # type: ignore[arg-type]

    # Repository history: the strongest real-world signal once it exists.
    logit += 0.38 * float(record["previous_risky_file_count"])  # type: ignore[arg-type]

    # Size, deliberately sublinear. Doubling a diff does not double its risk.
    logit += 0.55 * np.log1p(total_lines / 100)
    logit += 0.22 * np.log1p(float(record["files_changed"]) / 5)  # type: ignore[arg-type]

    # Complexity growth matters; simplification earns credit.
    complexity = float(record["complexity_delta"])  # type: ignore[arg-type]
    logit += 0.030 * max(0.0, complexity)
    logit -= 0.020 * max(0.0, -complexity)

    # Tests are the strongest mitigator available to an author.
    if record["test_files_changed"]:
        logit -= 0.80
    elif total_lines > 200:
        # Large and untested is the single worst combination in the rule set.
        logit += 0.70

    # Unsquashed history correlates with a branch that wandered.
    commits = float(record["number_of_commits"])  # type: ignore[arg-type]
    if commits > 15:
        logit += 0.25

    # Interaction: sensitive code without tests compounds rather than adding.
    sensitive = (
        float(record["auth_file_changed"])  # type: ignore[arg-type]
        + float(record["payment_file_changed"])  # type: ignore[arg-type]
        + float(record["database_file_changed"])  # type: ignore[arg-type]
    )
    if sensitive >= 1 and not record["test_files_changed"]:
        logit += 0.50 * sensitive

    return float(logit)


def synthesize_review_minutes(
    rng: np.random.Generator, record: dict[str, object], is_risky: int
) -> float:
    """Time from PR open to first human review.

    Target for the linear-regression estimator. Driven mainly by size, since that
    is what actually determines how long reading a diff takes, with a penalty for
    risky changes because reviewers slow down when something looks dangerous.
    """
    total_lines = float(record["lines_added"]) + float(record["lines_deleted"])  # type: ignore[arg-type]

    base = 6.0
    base += total_lines * 0.055
    base += float(record["files_changed"]) * 0.9  # type: ignore[arg-type]
    base += max(0.0, float(record["complexity_delta"])) * 0.30  # type: ignore[arg-type]
    base += 12.0 * float(record["auth_file_changed"])  # type: ignore[arg-type]
    base += 14.0 * float(record["payment_file_changed"])  # type: ignore[arg-type]
    base += 4.0 * float(record["security_findings_count"])  # type: ignore[arg-type]
    base += 18.0 * is_risky

    # Tests speed review up: the reviewer has something to trust.
    if record["test_files_changed"]:
        base *= 0.85

    # Multiplicative noise keeps the distribution positive and right-skewed, which
    # is how review latency actually behaves.
    return float(max(2.0, base * rng.lognormal(0, 0.35)))


def synthesize_issue_type(rng: np.random.Generator, record: dict[str, object]) -> str:
    """Label for the SVM issue-type classifier."""
    if record["security_findings_count"] and rng.random() < 0.7:
        return "security"
    if record["dependency_changed"] and rng.random() < 0.5:
        return "dependency"
    if not record["test_files_changed"] and rng.random() < 0.4:
        return "testing"
    if float(record["complexity_delta"]) > 20 and rng.random() < 0.6:  # type: ignore[arg-type]
        return "maintainability"
    return str(rng.choice(["bug", "performance", "style", "maintainability"]))


def synthesize_title(rng: np.random.Generator, is_risky: int) -> str:
    subject = str(rng.choice(SUBJECTS))

    # Correlation with the label is deliberately WEAK (30%, not 55%).
    #
    # Wording is a real but soft signal in practice: plenty of dangerous changes have
    # boring titles, and "hotfix" often sits on something trivial. An earlier version
    # used 55% and the model learned to classify almost entirely from text, reaching
    # a flattering AUC while effectively ignoring the numeric features — to the point
    # that an all-zero feature vector scored 97/100. Keeping the text signal weak
    # forces the model to rely on the structural features that are actually available
    # and trustworthy in production.
    if is_risky and rng.random() < 0.30:
        verb = str(rng.choice(HIGH_RISK_TITLE_PARTS))
    elif not is_risky and rng.random() < 0.30:
        verb = str(rng.choice(LOW_RISK_TITLE_PARTS))
    else:
        verb = str(rng.choice(NEUTRAL_TITLE_PARTS))

    return f"{verb} {subject}"


def synthesize_commits(rng: np.random.Generator, is_risky: int, count: int) -> str:
    messages: list[str] = []

    for _ in range(min(count, 12)):
        prefix = str(rng.choice(COMMIT_PREFIXES))
        subject = str(rng.choice(SUBJECTS))

        # Also weakened, and applied to both classes: "wip" and "fix build" appear in
        # perfectly safe branches too, so making them exclusive to risky PRs would
        # hand the model a shortcut that does not exist in real repositories.
        if rng.random() < (0.30 if is_risky else 0.12):
            messages.append(f"{prefix}: {rng.choice(RISKY_COMMIT_PHRASES)} {subject}")
        else:
            messages.append(f"{prefix}: update {subject}")

    return " \n ".join(messages)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=6000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=str, default="data/bootstrap_dataset.csv")
    args = parser.parse_args()

    frame = generate(args.samples, args.seed)

    output = Path(__file__).resolve().parents[1] / args.out
    output.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(output, index=False)

    positive_rate = frame["was_risky"].mean()

    print(f"Generated {len(frame)} samples -> {output}")
    print(f"  risky rate           : {positive_rate:.1%}")
    print(f"  median review minutes: {frame['review_minutes'].median():.1f}")
    print(f"  feature columns      : {len(NUMERIC_FEATURES)} numeric + 2 text")
    print(f"  issue type spread    : {frame['issue_type'].value_counts().to_dict()}")

    # A degenerate class balance produces a model that looks accurate and predicts
    # one class for everything, so fail loudly rather than train on it.
    if not 0.15 < positive_rate < 0.60:
        raise SystemExit(
            f"Positive rate {positive_rate:.1%} is outside the usable 15-60% range. "
            "Adjust the heuristic weights in compute_risk_logit."
        )


if __name__ == "__main__":
    main()
