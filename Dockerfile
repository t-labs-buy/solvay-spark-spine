# Solvay Spark Spine AI: the backend, the built UI and the tools it shells out
# to (LibreOffice, Poppler, Tesseract), in one image. Postgres, Ollama and Neo4j
# run beside it -- see compose.yml and docs/deployment.md.
#
#   scripts/docker-publish.sh      build for linux/amd64 and push to the registry

# ── UI: frontend/ builds into ../static/dist (frontend/vite.config.ts) ──────
# The output is plain HTML/JS/CSS, so it builds on the build machine's own
# platform rather than under emulation when cross-building for amd64.
FROM --platform=$BUILDPLATFORM node:22-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Docling's models, fetched on the build machine's own platform ──────────
# Running torch under amd64 emulation crashes qemu, and the model files are
# the same on every platform. The runtime points DOCLING_ARTIFACTS_PATH here,
# so the first conversion on the server downloads nothing.
FROM --platform=$BUILDPLATFORM python:3.12-slim-bookworm AS models
ARG TORCH_VERSION=2.14.0 TORCHVISION_VERSION=0.29.0
ENV PIP_NO_CACHE_DIR=1 PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10
# OpenCV's shared libraries: the RapidOCR download imports cv2.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libxcb1 \
    && rm -rf /var/lib/apt/lists/*
COPY constraints.txt .
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==${TORCH_VERSION} torchvision==${TORCHVISION_VERSION} \
    && pip install -c constraints.txt docling
RUN docling-tools models download -o /opt/docling-models

# ── Python environment, built with compilers the runtime does not need ─────
FROM python:3.12-slim-bookworm AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config libtesseract-dev libleptonica-dev \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ARG TORCH_VERSION=2.14.0 TORCHVISION_VERSION=0.29.0
ENV PATH=/opt/venv/bin:$PATH PIP_NO_CACHE_DIR=1 PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10
# CPU torch first: the default Linux wheel is the multi-GB CUDA build.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==${TORCH_VERSION} torchvision==${TORCHVISION_VERSION}
# Exact versions from constraints.txt, so every build resolves the same set.
COPY requirements.txt constraints.txt ./
RUN pip install -r requirements.txt -c constraints.txt

# ── Runtime ────────────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="solvay-spark-spine" \
      org.opencontainers.image.description="Solvay Spark Spine AI" \
      org.opencontainers.image.revision="${GIT_SHA}"

# LibreOffice + Poppler: preview.py renders the original and splits it into
# pages. Tesseract: pptx_ocr.py / table_cv.py. Pango/Cairo: WeasyPrint for
# rollout/pdf.py. libgl1/libglib: OpenCV.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
        poppler-utils \
        tesseract-ocr tesseract-ocr-eng \
        libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
        libgl1 libglib2.0-0 libxcb1 \
        fonts-dejavu curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /opt/venv /opt/venv
COPY --from=models /opt/docling-models /opt/docling-models
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    DOCLING_ARTIFACTS_PATH=/opt/docling-models

RUN useradd --create-home --uid 1000 app
WORKDIR /app
COPY backend/ backend/
COPY docs/ docs/
COPY data/ data/
COPY --from=ui /src/static/dist static/dist/
# Written at runtime; compose.yml mounts volumes over them.
RUN mkdir -p .workdir knowledge_base solvay-spark \
    && chown -R app:app .workdir knowledge_base data
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1
CMD ["uvicorn", "backend.api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
