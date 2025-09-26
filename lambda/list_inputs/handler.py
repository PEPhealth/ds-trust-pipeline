import os
import boto3

s3 = boto3.client("s3")

def handler(event, context):
    # event must include: { "s3_prefix": "s3://bucket/prefix/..." }
    pfx = event["s3_prefix"]
    assert pfx.startswith("s3://")
    _, rest = pfx.split("s3://", 1)
    bucket, prefix = rest.split("/", 1)

    keys = []
    cont = None
    while True:
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, ContinuationToken=cont) if cont else \
               s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
        for obj in resp.get("Contents", []):
            k = obj["Key"]
            if k.lower().endswith((".parquet", ".pq", ".csv")):
                keys.append(f"s3://{bucket}/{k}")
        if resp.get("IsTruncated"):
            cont = resp["NextContinuationToken"]
        else:
            break

    return {
        "bucket": bucket,
        "prefix": prefix,
        "keys": keys,             # array of s3://bucket/key
        "count": len(keys)
    }
