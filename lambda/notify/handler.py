import os, json, boto3

ssm = boto3.client("ssm")
sns = boto3.client("sns")

def _get_param(name: str) -> str:
    return ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]

def _first_existing(d: dict, paths):
    ...
    return None

def handler(event, _ctx):
    # existing tolerant extraction
    export_payload = _first_existing(event, [
        ["export"],
        ["Export", "Payload"],
        ["Payload"],
    ])
    ecs_payload = _first_existing(event, [["ecs"], ["Ecs"]])

    if not export_payload:
        raise KeyError(f"Missing export payload. Got top-level keys: {list(event.keys())}")

    run_id   = export_payload["run_id"]
    run_date = export_payload["run_date"]
    raw_prefix = export_payload["s3_prefix"]

    # 👇 NEW: pick up an optional email from the execution input
    notify_email = _first_existing(event, [["email"], ["Email"]])

    topic_arn   = _get_param(os.environ["PARAM_SNS_TOPIC"])
    data_bucket = _get_param(os.environ["PARAM_DATA_BUCKET"])
    scored_prefix = f"s3://{data_bucket}/trust_scoring/scored/run_id={run_id}/"

    # (optional) ecs details as before...
    exit_code = None
    stopped_reason = None
    try:
        tasks = (ecs_payload or {}).get("Tasks") or ecs_payload.get("tasks") or []
        if tasks:
            containers = tasks[0].get("Containers") or tasks[0].get("containers") or []
            if containers:
                exit_code = containers[0].get("ExitCode")
                stopped_reason = containers[0].get("Reason")
    except Exception:
        pass

    subject = f"Trust scoring complete — run_id={run_id}"
    message = {
        "run_id": run_id,
        "run_date": run_date,
        "raw_prefix": raw_prefix,
        "scored_prefix": scored_prefix,
    }
    if notify_email:
        message["notify_email"] = notify_email  #include in email body
    if exit_code is not None:
        message["ecs_exit_code"] = exit_code
    if stopped_reason:
        message["ecs_stopped_reason"] = stopped_reason

    sns.publish(
        TopicArn=topic_arn,
        Subject=subject,
        Message=json.dumps(message, indent=2),
    )

    return {"ok": True, "notified_topic": topic_arn, "message": message}