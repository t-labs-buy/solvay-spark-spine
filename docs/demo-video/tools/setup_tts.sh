#!/usr/bin/env bash
# One-time setup of the local, open-source narration voice (Kokoro-82M, Apache 2.0)
# and the speech-to-text used by check.py (Whisper via mlx-whisper).
#
#   bash setup_tts.sh            # creates ~/.cache/demo-video-tts (about 1.5 GB with models)
#
# Safe to re-run. Needs uv (https://docs.astral.sh/uv/) and a Python 3.10–3.12; Kokoro
# does not support newer Pythons yet. Apple Silicon recommended (mlx-whisper is
# Apple-only; on other machines narration works and check.py skips speech-to-text).
set -euo pipefail

ENV="${KOKORO_ENV:-$HOME/.cache/demo-video-tts}"
PY="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || true)"
[ -n "$PY" ] || { echo "Need python3.10–3.12 on PATH (e.g. brew install python@3.12)"; exit 1; }
command -v uv >/dev/null || { echo "Need uv: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
command -v ffmpeg >/dev/null || echo "warning: ffmpeg not found — brew install ffmpeg (build.py needs it)"

[ -x "$ENV/bin/python" ] || uv venv "$ENV" --python "$PY" -q
export VIRTUAL_ENV="$ENV"
uv pip install -q "kokoro>=0.9" soundfile \
  "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
if [ "$(uname -m)" = "arm64" ] && [ "$(uname -s)" = "Darwin" ]; then
  uv pip install -q mlx-whisper
fi

# Warm the model downloads so the first real run is quick.
"$ENV/bin/python" - <<'EOF'
import warnings; warnings.filterwarnings("ignore")
from kokoro import KPipeline
KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
print("Kokoro ready")
EOF
echo "TTS environment: $ENV/bin/python"
