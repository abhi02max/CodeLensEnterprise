"""Operator-only manifest creation for an already TRUSTED artifact. No training."""

import argparse
import io
import sys
from pathlib import Path

import joblib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.strict_risk import ARTIFACT_BYTES, canonical, manifest_for, read_regular


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--trusted-operator-artifact", action="store_true", required=True)
    args = parser.parse_args()
    data = read_regular(args.artifact, ARTIFACT_BYTES)
    manifest = manifest_for(data, joblib.load(io.BytesIO(data)))
    destination = args.artifact.with_suffix(".manifest.json")
    with destination.open("xb") as file:
        file.write(canonical(manifest.model_dump()))
    print("Trusted artifact manifest created")


if __name__ == "__main__":
    main()
