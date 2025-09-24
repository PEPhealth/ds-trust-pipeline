import os, boto3

sns = boto3.client("sns")
ssm = boto3.client("ssm")

def _get(name):
    return ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]

def handler(event, _ctx):
    run_id   = event["Export"]["Payload"]["run_id"]
    run_date = event["Export"]["Payload"]["run_date"]
    topic_arn = _get(os.environ["PARAM_SNS_TOPIC"])
    data_bucket = _get(os.environ["PARAM_DATA_BUCKET"])
    prefix = f"s3://{data_bucket}/trust_scoring/scored/run_id={run_id}/"

    sns.publish(
        TopicArn=topic_arn,
        Subject=f"Trust scoring complete: {run_id}",
        Message=f"Date: {run_date}\nOutputs: {prefix}"
    )
    return {"ok": True}
