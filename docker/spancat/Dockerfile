FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY . /app/

RUN apt-get update && apt-get install -y build-essential curl && rm -rf /var/lib/apt/lists/*

# Ensure entrypoint has LF endings + executable bit
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Pin deps - match  models (spaCy 3.7.x) + Parquet/S3 IO
RUN pip install --no-cache-dir \
    "spacy==3.7.5" \
    "pandas==1.5.3" \
    "numpy==1.24.3" \
    "pyarrow==19.0.1" \
    "s3fs>=2023.6.0" \
    "fsspec>=2023.6.0" \
    "boto3" \
    "smart_open" \
    "spacy-transformers" \
    "spacy-experimental" \
    "sentence-transformers" \
    "emoji" \
    "tqdm" \
    "joblib" \
    "scikit-learn"


ENTRYPOINT ["/app/entrypoint.sh"]


