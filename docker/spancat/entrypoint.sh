#!/usr/bin/env bash
set -euo pipefail

cd /app

: "${INPUT_PREFIX:?missing INPUT_PREFIX}"
: "${OUTPUT_PREFIX:?missing OUTPUT_PREFIX}"
: "${TEXT_COL:=cleaned_comment}"
: "${AWS_DEFAULT_REGION:=us-east-2}"

echo "[spancat] Python: $(python -V)"
echo "[spancat] spaCy:  $(python -c 'import spacy; print(spacy.__version__)')"
echo "[spancat] CWD=$(pwd)"
echo "[spancat] Files here: $(ls -1 | tr '\n' ' ')"
echo "[spancat] INPUT_PREFIX=$INPUT_PREFIX"
echo "[spancat] OUTPUT_PREFIX=$OUTPUT_PREFIX"
echo "[spancat] TEXT_COL=$TEXT_COL"

# Optional: exit success if no parquet files
if command -v aws >/dev/null 2>&1; then
  if ! aws s3 ls "$INPUT_PREFIX" | grep -q '\.parquet'; then
    echo "[spancat] No parquet files under $INPUT_PREFIX — exiting success."
    exit 0
  fi
fi

# Try to discover which flags your script supports
HELP_OUT="$(python /app/run_spancat_over_table.py --help 2>&1 || true)"
echo "[spancat] detected help (first lines):"
echo "$HELP_OUT" | head -n 40

# prefer single-file INPUT if provided; otherwise fall back to PREFIX
if [[ -n "${INPUT:-}" ]]; then
  IN_FLAG="--input"
  OUT_FLAG="--output-prefix"
  argv=( "$IN_FLAG" "$INPUT" "$OUT_FLAG" "$OUTPUT_PREFIX" )
else
  if grep -q -- '--input-prefix'  <<<"$HELP_OUT"; then IN_FLAG="--input-prefix"; else IN_FLAG="--input"; fi
  if grep -q -- '--output-prefix' <<<"$HELP_OUT"; then OUT_FLAG="--output-prefix"; else OUT_FLAG="--output"; fi
  argv=( "$IN_FLAG" "$INPUT_PREFIX" "$OUT_FLAG" "$OUTPUT_PREFIX" )
fi

# Text column flag (common variants)
TEXT_FLAG=""
if   grep -q -- '--text-col'     <<<"$HELP_OUT"; then TEXT_FLAG="--text-col"
elif grep -q -- '--text_column'  <<<"$HELP_OUT"; then TEXT_FLAG="--text_column"
elif grep -q -- '--text'         <<<"$HELP_OUT"; then TEXT_FLAG="--text"
fi

# Optional config flags (only if present)
MODELS_JSON_ARG=()
if grep -q -- '--models-json' <<<"$HELP_OUT"; then
  MODELS_JSON_ARG=(--models-json "/app/models.json")
elif grep -q -- '--models' <<<"$HELP_OUT"; then
  MODELS_JSON_ARG=(--models "/app/models.json")
fi

THRESHOLDS_JSON_ARG=()
if grep -q -- '--thresholds-json' <<<"$HELP_OUT"; then
  THRESHOLDS_JSON_ARG=(--thresholds-json "/app/thresholds.json")
elif grep -q -- '--thresholds' <<<"$HELP_OUT"; then
  THRESHOLDS_JSON_ARG=(--thresholds "/app/thresholds.json")
fi

# Build argv with what we discovered; script defaults will be used if flags not supported
#argv=( "$IN_FLAG" "$INPUT_PREFIX" "$OUT_FLAG" "$OUTPUT_PREFIX" )
[[ -n "$TEXT_FLAG" ]] && argv+=( "$TEXT_FLAG" "$TEXT_COL" )
argv+=( "${MODELS_JSON_ARG[@]}" "${THRESHOLDS_JSON_ARG[@]}" )

echo "[spancat] running: python /app/run_spancat_over_table.py ${argv[*]}"
exec python /app/run_spancat_over_table.py "${argv[@]}"
