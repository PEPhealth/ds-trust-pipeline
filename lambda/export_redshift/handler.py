import os, json, uuid, time, datetime
from zoneinfo import ZoneInfo
import boto3

ssm = boto3.client("ssm")

def _get_param(name: str) -> str:
    return ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]

def handler(event, _ctx):

    # build region-specific redshift-data client
    region = os.environ["RS_REGION"]
    rs = boto3.client("redshift-data", region_name=region)
    secrets = boto3.client("secretsmanager", region_name=region)
    
    unload_role_arn = os.environ.get("UNLOAD_ROLE_ARN") or _get_param(os.environ["PARAM_UNLOAD_ROLE"])

    run_id = event.get("run_id") or str(uuid.uuid4())
    run_date = event.get("run_date") or datetime.datetime.now(ZoneInfo("Europe/London")).date().isoformat()

    data_bucket     = _get_param(os.environ["PARAM_DATA_BUCKET"])
    sql_template    = _get_param(os.environ["PARAM_SQL"])
    workgroup       = _get_param(os.environ["PARAM_RS_WORKGROUP"])
    database        = _get_param(os.environ["PARAM_RS_DATABASE"])
    
    if not unload_role_arn or not unload_role_arn.strip():
        raise ValueError("Unload role ARN resolved empty. Check UNLOAD_ROLE_ARN env or /trust_scoring/redshift/unload_role_arn in SSM.")

    secret_id = os.environ.get("DB_SECRET_ARN")  # name or partial ARN is fine
    if not secret_id:
        raise ValueError("DB_SECRET_ARN not set.")
    secret_arn = boto3.client("secretsmanager", region_name=os.environ["RS_REGION"]).get_secret_value(SecretId=secret_id)["ARN"]

    prefix = f"s3://{data_bucket}/trust_scoring/raw/run_date={run_date}/run_id={run_id}/batch_"

    #inject as DATE literal
    sql_inner = sql_template.replace(":run_date", f"DATE '{run_date}'")

    unload = f"""
    UNLOAD ($${sql_inner}$$)
    TO '{prefix}'
    IAM_ROLE '{unload_role_arn}'
    FORMAT AS PARQUET
    PARALLEL ON
    ;
    """

    

    # Fail fast if the UNLOAD role is missing
    unload_role_arn = os.environ.get("UNLOAD_ROLE_ARN") or _get_param(os.environ["PARAM_UNLOAD_ROLE"])
    if not unload_role_arn or not unload_role_arn.strip():
        raise ValueError("Unload role ARN resolved empty. Check UNLOAD_ROLE_ARN or the SSM param.")

    args = dict(WorkgroupName=workgroup, 
                Database=database, Sql=unload, 
                SecretArn=secret_arn)

    resp = rs.execute_statement(**args)
    sid = resp["Id"]

    delay = 1.0
    while True:
        d = rs.describe_statement(Id=sid)
        s = d["Status"]
        if s in ("FINISHED","FAILED","ABORTED"):
            if s != "FINISHED":
                raise RuntimeError(json.dumps(d, default=str))
            break
        time.sleep(delay)
        delay = min(delay * 1.5, 10.0)

    return {
        "run_id": run_id,
        "run_date": run_date,
        "s3_prefix": prefix.rsplit("/",1)[0] + "/"
    }
