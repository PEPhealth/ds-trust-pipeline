import os
import json
import tarfile
import argparse
import re #ithink not needed
import gc
import tempfile

import pandas as pd

import s3fs
import boto3

import spacy

from datetime import datetime
from typing import Dict, List, Tuple, Set

# ---------- I/O helpers ----------

def read_table(path: str) -> pd.DataFrame:
    if path.startswith("s3://"):
        fs = s3fs.S3FileSystem()
        ext = os.path.splitext(path)[1].lower()
        with fs.open(path, "rb") as f:
            if ext in [".parquet", ".pq"]:
                return pd.read_parquet(f)
            elif ext in [".csv", ".txt"]:
                return pd.read_csv(f)
            else:
                raise ValueError(f"Unsupported extension: {ext}")
    else:
        if path.lower().endswith((".parquet", ".pq")):
            return pd.read_parquet(path)
        return pd.read_csv(path)

def write_table(df: pd.DataFrame, path: str):
    ext = os.path.splitext(path)[1].lower()
    if path.startswith("s3://"):
        fs = s3fs.S3FileSystem()
        with fs.open(path, "wb") as f:
            if ext in [".parquet", ".pq"]:
                df.to_parquet(f, index=False)
            elif ext == ".csv":
                df.to_csv(f, index=False)
            else:
                raise ValueError(f"Unsupported extension: {ext}")
    else:
        if ext in [".parquet", ".pq"]:
            df.to_parquet(path, index=False)
        elif ext == ".csv":
            df.to_csv(path, index=False)
        else:
            raise ValueError(f"Unsupported extension: {ext}")

# ---------- model loading ----------

def load_exclusion_list(file_path: str) -> Set[str]:
    if not file_path or not os.path.exists(file_path):
        return set()
    with open(file_path, "r", encoding="utf-8") as f:
        return {line.strip().lower() for line in f if line.strip()}

def download_and_extract_model(s3_bucket: str, s3_key: str, local_dir: str) -> str:
    """Downloads model.tar.gz from S3 and returns path to extracted pipeline dir."""
    os.makedirs(local_dir, exist_ok=True)
    local_tar = os.path.join(local_dir, "model.tar.gz")
    boto3.client("s3").download_file(s3_bucket, s3_key, local_tar)
    with tarfile.open(local_tar, "r:gz") as tar:
        tar.extractall(local_dir)
    # common export names: ./model-last or ./model-best
    for name in ["model-last", "model-best"]:
        candidate = os.path.join(local_dir, name)
        if os.path.exists(candidate):
            return candidate
    # fallback to first dir with meta.json
    for root, dirs, files in os.walk(local_dir):
        if "meta.json" in files and "config.cfg" in files:
            return root
    raise RuntimeError("Could not find extracted spaCy model folder")

def load_models(model_map: Dict[str, Dict[str, str]]) -> List[Tuple[spacy.Language, str]]:
    """
    (Kept for compatibility; not used in main anymore.)
    model_map: { label: {"bucket": "...", "key": "path/to/model.tar.gz"} }
    Returns list of (nlp, label) by loading ALL models (high memory).
    """
    pairs = []
    for label, loc in model_map.items():
        path = download_and_extract_model(loc["bucket"], loc["key"], local_dir=f".cache/{label}")
        nlp = spacy.load(path)
        pairs.append((nlp, label))
    return pairs

# ---------- inference ----------

def run_spancat_on_text(text: str,
                        models: List[Tuple[spacy.Language, str]],
                        thresholds: Dict[str, float],
                        exclusion: Set[str]) -> List[Dict]:
    """
    (Kept for compatibility; used when all models are preloaded.)
    """
    matches = []
    for nlp, label in models:
        doc = nlp(text)
        th = thresholds.get(label, 0.5)
        if "sc" in doc.spans and "scores" in doc.spans["sc"].attrs:
            for span, score in zip(doc.spans["sc"], doc.spans["sc"].attrs["scores"]):
                if score >= th and span.text.lower() not in exclusion:
                    matches.append({
                        "theme": label,
                        "theme_text": span.text,
                        "theme_start_char": span.start_char,
                        "theme_end_char": span.end_char,
                        "theme_start_token": span.start,
                        "theme_end_token": span.end,
                        "score": float(score),
                    })
    return matches

def process_table(df: pd.DataFrame,
                  text_col: str,
                  models: List[Tuple[spacy.Language, str]],
                  thresholds: Dict[str, float],
                  exclusion: Set[str]) -> pd.DataFrame:
    """
    (Kept for compatibility; processes with ALL models resident in memory.)
    """
    all_rows = []
    today = datetime.now().strftime("%Y-%m-%d")
    for idx, row in df.iterrows():
        text = str(row[text_col]) if text_col in row and pd.notna(row[text_col]) else ""
        hits = run_spancat_on_text(text, models, thresholds, exclusion)
        if hits:
            base = row.to_dict()
            for h in hits:
                out = dict(base)
                out.update(h)
                out["relevant"] = 1
                out["pattern_check_date"] = today
                all_rows.append(out)
        else:
            # keep rows with no match? set keep_no_match=False to skip
            pass
    return pd.DataFrame(all_rows)

# ---------- low-memory sequential pipeline ----------

def _run_single_model_over_df(df: pd.DataFrame,
                              text_col: str,
                              nlp: spacy.Language,
                              label: str,
                              threshold: float,
                              exclusion: Set[str]) -> List[Dict]:
    rows = []
    today = datetime.now().strftime("%Y-%m-%d")
    for _, row in df.iterrows():
        text = str(row[text_col]) if text_col in row and pd.notna(row[text_col]) else ""
        if not text:
            continue
        doc = nlp(text)
        hits = []
        if "sc" in doc.spans and "scores" in doc.spans["sc"].attrs:
            for span, score in zip(doc.spans["sc"], doc.spans["sc"].attrs["scores"]):
                if score >= threshold and span.text.lower() not in exclusion:
                    hits.append({
                        "theme": label,
                        "theme_text": span.text,
                        "theme_start_char": span.start_char,
                        "theme_end_char": span.end_char,
                        "theme_start_token": span.start,
                        "theme_end_token": span.end,
                        "score": float(score),
                        "relevant": 1,
                        "pattern_check_date": today
                    })
        if hits:
            base = row.to_dict()
            for h in hits:
                out = dict(base)
                out.update(h)
                rows.append(out)
        # else: skip no-match rows (same behaviour as process_table)
    return rows

def process_table_sequential(df: pd.DataFrame,
                             text_col: str,
                             model_map: Dict[str, Dict[str, str]],
                             thresholds: Dict[str, float],
                             exclusion: Set[str]) -> pd.DataFrame:
    """
    Load models ONE AT A TIME, run over full df, free, repeat.
    model_map: { label: {"bucket": "...", "key": "path/to/model.tar.gz"} }
    """
    all_rows: List[Dict] = []
    for label, loc in model_map.items():
        # download & load this model only
        model_dir = download_and_extract_model(loc["bucket"], loc["key"],
                                               local_dir=os.path.join(tempfile.gettempdir(), "models", label))
        nlp = spacy.load(model_dir)
        thr = float(thresholds.get(label, 0.5))
        try:
            all_rows.extend(_run_single_model_over_df(df, text_col, nlp, label, thr, exclusion))
        finally:
            # free memory aggressively between models
            try:
                del nlp
            except Exception:
                pass
            gc.collect()
    return pd.DataFrame(all_rows)

# ---------- main ----------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input CSV/Parquet (local or s3://)")
    parser.add_argument("--output", required=True, help="Output CSV/Parquet (local or s3://)")
    parser.add_argument("--text-col", default="cleaned_comment")
    parser.add_argument("--exclusion-file", default="", help="Optional path to exclude_strings.txt")
    parser.add_argument("--thresholds-json", required=True,
                        help="JSON file with per-label thresholds, e.g. {\"Gratitude\":0.5,...}")
    parser.add_argument("--models-json", required=True,
                        help=("JSON file mapping labels to S3 buckets/keys, "
                              "e.g. {\"Gratitude\":{\"bucket\":\"my-b\",\"key\":\"path/model.tar.gz\"}, ...}"))
    args = parser.parse_args()

    exclusion = load_exclusion_list(args.exclusion_file)

    with open(args.thresholds_json, "r", encoding="utf-8") as f:
        thresholds = json.load(f)
    with open(args.models_json, "r", encoding="utf-8") as f:
        model_map = json.load(f)

    # low-memory path - process models sequentially
    df = read_table(args.input)
    out = process_table_sequential(df, args.text_col, model_map, thresholds, exclusion)

    #original all-in-memory behaviour - swap to:
    # models = load_models(model_map)
    # out = process_table(df, args.text_col, models, thresholds, exclusion)

    write_table(out, args.output)
    print(f"Done. Wrote {len(out)} rows to {args.output}")

if __name__ == "__main__":
    main()
