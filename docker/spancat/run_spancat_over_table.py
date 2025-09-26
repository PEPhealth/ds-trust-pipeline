import os, json, tarfile, argparse, re, sys
from datetime import datetime
from typing import Dict, List, Tuple, Set, Iterable

import boto3
import pandas as pd
import s3fs
import spacy

# ---- extra libs used by your post-processing / recommend step ----
from sentence_transformers import SentenceTransformer
import joblib
from run_filter_trust import (
    time_fix_punctuation,
    fix_same_subdomain_overlapping_spans,
    fix_different_subdomain_overlapping_spans,
)

import gc

# ---------- I/O helpers ----------

def _is_s3(p: str) -> bool:
    return p.startswith("s3://")

def _has_ext(p: str) -> bool:
    return os.path.splitext(p)[1].lower() != ""

def _is_prefix(p: str) -> bool:
    # Treat as prefix if it ends with "/" or has no extension
    return p.endswith("/") or not _has_ext(p)

def list_s3_objects(prefix: str, exts=(".parquet", ".pq", ".csv")) -> List[str]:
    fs = s3fs.S3FileSystem()
    # s3fs.ls returns keys without scheme for bucket roots sometimes; normalize
    paths = []
    for key in fs.ls(prefix):
        full = "s3://" + key if not key.startswith("s3://") else key
        if any(full.lower().endswith(ext) for ext in exts):
            paths.append(full)
    return sorted(paths)

def read_table(path: str) -> pd.DataFrame:
    if _is_s3(path):
        fs = s3fs.S3FileSystem()
        ext = os.path.splitext(path)[1].lower()
        with fs.open(path, "rb") as f:
            if ext in [".parquet", ".pq"]:
                return pd.read_parquet(f)
            elif ext in [".csv", ".txt"]:
                return pd.read_csv(f)
            else:
                raise ValueError(f"Unsupported extension: {ext} for {path}")
    else:
        ext = os.path.splitext(path)[1].lower()
        if ext in [".parquet", ".pq"]:
            return pd.read_parquet(path)
        elif ext in [".csv", ".txt"]:
            return pd.read_csv(path)
        else:
            raise ValueError(f"Unsupported extension: {ext} for {path}")

def write_table(df: pd.DataFrame, path: str):
    ext = os.path.splitext(path)[1].lower()
    if _is_s3(path):
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

# ---------- model loading (SpanCat) ----------
def process_table_sequential(df: pd.DataFrame,
                             text_col: str,
                             model_map: Dict[str, Dict[str, str]],
                             thresholds: Dict[str, float],
                             exclusion: Set[str]) -> pd.DataFrame:
    """Memory-friendly: load one model at a time, run over all rows, then free it."""
    all_rows = []
    today = datetime.now().strftime("%Y-%m-%d")

    # pre-extract all model archives once (no memory cost, just disk)
    local_paths = {}
    for label, loc in model_map.items():
        local_paths[label] = download_and_extract_model(loc["bucket"], loc["key"], f".cache/{label}")

    texts = df[text_col].fillna("").astype(str).tolist()
    bases = df.to_dict(orient="records")

    for label, model_dir in local_paths.items():
        th = thresholds.get(label, 0.5)
        nlp = spacy.load(model_dir)
        try:
            for doc, base in zip(nlp.pipe(texts, batch_size=32), bases):
                if "sc" in doc.spans and "scores" in doc.spans["sc"].attrs:
                    for span, score in zip(doc.spans["sc"], doc.spans["sc"].attrs["scores"]):
                        if float(score) >= th and span.text.lower() not in exclusion:
                            out = dict(base)
                            out.update({
                                "theme": label,
                                "theme_text": span.text,
                                "theme_start_char": int(span.start_char),
                                "theme_end_char": int(span.end_char),
                                "theme_start_token": int(span.start),
                                "theme_end_token": int(span.end),
                                "score": float(score),
                                "relevant": 1,
                                "pattern_check_date": today,
                            })
                            all_rows.append(out)
        finally:
            # free RAM used by this model before moving to the next
            del nlp
            gc.collect()

    return pd.DataFrame(all_rows)


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
    # fallback to dir having config.cfg
    for root, dirs, files in os.walk(local_dir):
        if "config.cfg" in files:
            return root
    raise RuntimeError("Could not find extracted spaCy model folder")

def load_models(model_map: Dict[str, Dict[str, str]]) -> List[Tuple[spacy.Language, str]]:
    """
    model_map: { label: {"bucket": "...", "key": "path/to/model.tar.gz"} }
    Returns list of (nlp, label)
    """
    pairs = []
    for label, loc in model_map.items():
        path = download_and_extract_model(loc["bucket"], loc["key"], local_dir=f".cache/{label}")
        nlp = spacy.load(path)
        pairs.append((nlp, label))
    return pairs

# ---------- inference (SpanCat) ----------

def run_spancat_on_text(text: str,
                        models: List[Tuple[spacy.Language, str]],
                        thresholds: Dict[str, float],
                        exclusion: Set[str]) -> List[Dict]:
    matches = []
    for nlp, label in models:
        doc = nlp(text)
        th = thresholds.get(label, 0.5)
        if "sc" in doc.spans and "scores" in doc.spans["sc"].attrs:
            for span, score in zip(doc.spans["sc"], doc.spans["sc"].attrs["scores"]):
                if float(score) >= th and span.text.lower() not in exclusion:
                    matches.append({
                        "theme": label,
                        "theme_text": span.text,
                        "theme_start_char": int(span.start_char),
                        "theme_end_char": int(span.end_char),
                        "theme_start_token": int(span.start),
                        "theme_end_token": int(span.end),
                        "score": float(score),
                    })
    return matches

def process_table(df: pd.DataFrame,
                  text_col: str,
                  models: List[Tuple[spacy.Language, str]],
                  thresholds: Dict[str, float],
                  exclusion: Set[str]) -> pd.DataFrame:
    all_rows = []
    today = datetime.now().strftime("%Y-%m-%d")
    for _, row in df.iterrows():
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
    return pd.DataFrame(all_rows)

# ---------- recommend model helpers ----------

def download_recommend_model(bucket: str, key: str, extract_dir: str = ".cache/recommend") -> str:
    os.makedirs(extract_dir, exist_ok=True)
    tar_path = os.path.join(extract_dir, "recommend.tar.gz")
    boto3.client("s3").download_file(bucket, key, tar_path)
    with tarfile.open(tar_path, "r:gz") as tar:
        tar.extractall(extract_dir)
    # expect model-last or model-best
    for name in ["model-last", "model-best"]:
        p = os.path.join(extract_dir, name)
        if os.path.exists(p):
            return p
    for root, dirs, files in os.walk(extract_dir):
        if "config.cfg" in files:
            return root
    raise RuntimeError("recommend textcat model not found in archive")

def apply_filters_and_recommend(
    spans_df: pd.DataFrame,
    recommend_nlp: spacy.language.Language | None,
    knn_path: str | None,
    le_path: str | None,
    embedding_model_name: str = "paraphrase-MiniLM-L6-v2",
    *,                       # ← keyword-only after here
    knn_obj=None,
    le_obj=None,
    emb_obj=None,
) -> pd.DataFrame:
    """
    - fix punctuation + emoji relevance
    - collapse overlaps (same/different subdomain) using KNN + sentence-transformers
    - run recommend textcat (if available) on rows where relevant==1
    """
    if spans_df.empty:
        return spans_df

    # 1) punctuation & emoji relevance
    data = spans_df.to_dict(orient="records")
    data = time_fix_punctuation(data)  # updates in place (and sets relevant=0 for emoji)

    # choose group key
    key_col = "comment_id" if "comment_id" in spans_df.columns else (
        "comment_unique_key" if "comment_unique_key" in spans_df.columns else None
    )
    if key_col is None:
        # fallback: treat each row separately
        key_col = "_row_idx"
        for i, d in enumerate(data):
            d[key_col] = i

    # 2) group & same-subdomain overlap fix
    spans_by_comment = {}
    for row in data:
        spans_by_comment.setdefault(row[key_col], []).append(row)
    spans_by_comment = fix_same_subdomain_overlapping_spans(spans_by_comment)

    # 3) different-subdomain overlap fix via KNN (optional)
    # 3) different-subdomain overlap fix via KNN (optional)
    knn, le, emb = knn_obj, le_obj, emb_obj
    if (knn is None or le is None or emb is None) and knn_path and le_path:
        try:
            knn = knn or joblib.load(knn_path)
            le  = le  or joblib.load(le_path)
            emb = emb or SentenceTransformer(embedding_model_name)
        except Exception as e:
            print(f"[warn] could not load KNN/LE/embedding model: {e}")
            knn, le, emb = None, None, None

    if knn and le and emb:
        spans_by_comment = fix_different_subdomain_overlapping_spans(spans_by_comment, emb, knn, le)

    # flatten back to df
    processed = [s for spans in spans_by_comment.values() for s in spans]
    df = pd.DataFrame(processed)

    # ensure relevant column exists
    if "relevant" not in df.columns:
        df["relevant"] = 1

    # 4) recommend textcat on relevant rows (optional)
    if recommend_nlp is not None and "textcat" in recommend_nlp.pipe_names:
        mask = df["relevant"] == 1
        if mask.any():
            sub = df.loc[mask].copy()
            preds = []
            for _, r in sub.iterrows():
                txt = r.get("theme_text") or ""
                if not txt:
                    preds.append((None, None))
                    continue
                doc = recommend_nlp(txt)
                if not doc.cats:
                    preds.append((None, None))
                else:
                    lab = max(doc.cats, key=doc.cats.get)
                    preds.append((lab, float(doc.cats.get(lab, 0.0))))
            sub[["recommend", "confidence"]] = pd.DataFrame(preds, index=sub.index)
            df.loc[sub.index, ["recommend", "confidence"]] = sub[["recommend", "confidence"]]
        else:
            # no relevant rows
            pass
    else:
        # create empty columns if missing
        if "recommend" not in df.columns:
            df["recommend"] = None
        if "confidence" not in df.columns:
            df["confidence"] = None

    return df

# ---------- main ----------

def main():
    parser = argparse.ArgumentParser()
    # input/output (file OR prefix)
    g_io = parser.add_mutually_exclusive_group(required=True)
    g_io.add_argument("--input", help="Input CSV/Parquet file (local or s3://)")
    g_io.add_argument("--input-prefix", help="S3 or local prefix containing files")

    g_out = parser.add_mutually_exclusive_group(required=True)
    g_out.add_argument("--output", help="Output CSV/Parquet file (local or s3://)")
    g_out.add_argument("--output-prefix", help="S3 or local prefix to write multiple parts")

    parser.add_argument("--text-col", default="cleaned_comment")
    parser.add_argument("--exclusion-file", default="", help="Optional path to exclude_strings.txt")
    parser.add_argument("--thresholds-json", required=True,
                        help='JSON: {"Gratitude":0.5,...}')
    parser.add_argument("--models-json", required=True,
                        help='JSON: {"Gratitude":{"bucket":"b","key":"path/model.tar.gz"}, ...}')

    # recommend (defaults keep current behavior if you don’t pass flags)
    parser.add_argument("--recommend-model-s3-bucket", default="aws-emr-studio-977903982786-us-east-1")
    parser.add_argument("--recommend-model-s3-key", default="ECU-trust-subdomains/recommend-test/model.tar.gz")
    parser.add_argument("--knn-path", default="./models/knn_model.sav")
    parser.add_argument("--label-encoder-path", default="./models/label_encoder.sav")
    parser.add_argument("--embedding-model-name", default="paraphrase-MiniLM-L6-v2")
    parser.add_argument("--skip-recommend", action="store_true", help="Skip recommend textcat & KNN fixes")
    parser.add_argument("--load-mode", choices=["sequential","all"], default="sequential",
                        help="Load models one-by-one (low memory) or all at once.")
    
    args = parser.parse_args()

    exclusion = load_exclusion_list(args.exclusion_file)

    with open(args.thresholds_json, "r", encoding="utf-8") as f:
        thresholds = json.load(f)
    with open(args.models_json, "r", encoding="utf-8") as f:
        model_map = json.load(f)

    # Determine inputs
    inputs: List[str]
    if args.input:
        if _is_prefix(args.input):
            raise ValueError("--input looks like a prefix. Use --input-prefix instead.")
        inputs = [args.input]
    else:
        # prefix mode
        if _is_s3(args.input_prefix):
            inputs = list_s3_objects(args.input_prefix, exts=(".parquet", ".pq", ".csv"))
        else:
            # local prefix
            base = args.input_prefix
            if not base.endswith(os.sep):
                base += os.sep
            # collect files in dir
            all_files = [os.path.join(base, f) for f in os.listdir(base)]
            inputs = [p for p in all_files if _has_ext(p) and p.lower().endswith((".parquet", ".pq", ".csv"))]
        if not inputs:
            print(f"[spancat] No input files found under prefix: {args.input_prefix}")
            return

    # Prepare recommend assets ONCE
    recommend_nlp = None
    if not args.skip_recommend:
        try:
            rec_dir = download_recommend_model(args.recommend_model_s3_bucket, args.recommend_model_s3_key)
            recommend_nlp = spacy.load(rec_dir)
        except Exception as e:
            print(f"[warn] Could not load recommend model: {e}")
            recommend_nlp = None

    # (optional) preload KNN/LE/emb once
    knn_obj = le_obj = emb_obj = None
    if not args.skip_recommend:
        try:
            if os.path.exists(args.knn_path) and os.path.exists(args.label_encoder_path):
                knn_obj = joblib.load(args.knn_path)
                le_obj  = joblib.load(args.label_encoder_path)
                emb_obj = SentenceTransformer(args.embedding_model_name)
        except Exception as e:
            print(f"[warn] Could not preload KNN/LE/emb: {e}")

    # Process each input file
    for idx, in_path in enumerate(inputs, start=1):
        df_in = read_table(in_path)

        if args.load_mode == "all":
            models = load_models(model_map)
            scored = process_table(df_in, args.text_col, models, thresholds, exclusion)
        else:
            scored = process_table_sequential(df_in, args.text_col, model_map, thresholds, exclusion)

        if not scored.empty:
            scored = apply_filters_and_recommend(
                spans_df=scored,
                recommend_nlp=recommend_nlp,
                knn_path=(None if args.skip_recommend else args.knn_path),
                le_path=(None if args.skip_recommend else args.label_encoder_path),
                embedding_model_name=args.embedding_model_name,
                knn_obj=knn_obj, le_obj=le_obj, emb_obj=emb_obj,   # reuse once-loaded objects
            )

        # figure output target
        if args.output:
            out_path = args.output
            # if output looks like a directory/prefix, synthesize a file name
            if _is_prefix(out_path):
                out_path = out_path.rstrip("/") + f"/part_{idx:05d}.parquet"
            elif not _has_ext(out_path):
                out_path = out_path + ".parquet"
        else:
            # prefix mode → always write parquet part files
            prefix = args.output_prefix.rstrip("/")
            out_path = f"{prefix}/part_{idx:05d}.parquet"

        write_table(scored, out_path)
        print(f"[spancat] wrote {len(scored)} rows → {out_path}")

    print("[spancat] DONE.")

if __name__ == "__main__":
    main()