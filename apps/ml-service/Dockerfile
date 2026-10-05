# Python 3.12 rather than the newest release: scikit-learn, xgboost and numpy all
# ship prebuilt wheels for it. On a very new interpreter pip falls back to building
# from source, which turns a 40-second image build into a 20-minute one and needs a
# full toolchain in the image.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# libgomp1 is required by xgboost's OpenMP runtime; without it the import fails at
# runtime with an opaque shared-library error.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first so a source change does not invalidate the install layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts

# Train at build time so the image ships with working models and the container is
# useful the moment it starts. Without this, a fresh deployment serves 503 from
# /predict/risk until someone remembers to run training.
#
# The artifacts directory is also a volume mount point in docker-compose, so a
# retrain from the host replaces these without rebuilding.
RUN mkdir -p artifacts && python scripts/train.py --samples 6000 --seed 42
RUN python scripts/manifest_artifact.py artifacts/models.joblib --trusted-operator-artifact

# Verify the artifacts are actually loadable before the image is considered good.
# Catches a serialization mismatch at build time rather than in production.
RUN python scripts/check_model_quality.py --min-auc 0.70

# Non-root: this process evaluates model artifacts and has no need for write access
# to anything but the artifacts directory.
RUN useradd --create-home --shell /bin/false codelens \
    && chown -R codelens:codelens /app
USER codelens

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)"

# Single worker by default. Each worker loads its own copy of the model bundle, so
# scaling is a matter of running more containers rather than more workers in one.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
