# Trust Pipeline (AWS CDK)

This project defines a reusable AWS Step Functions pipeline for running **spaCy SpanCat trust scoring models** on data from **Amazon Redshift**.  

It automates the workflow:

1. **Export from Redshift** → runs a SQL query and UNLOADs results to S3 (Parquet).  
2. **Score with SpanCat** → processes exported rows in an ECS Fargate container, applying multiple models.  
3. **Write results** → saves scored spans back to S3.  
4. **Notify** → sends an SNS email when the run is complete.

High level workflow:

```nginx
Redshift → S3 (raw) → ECS Fargate / SpanCat → S3 (scored) → SNS → Email
```

## 📂 Data Flow

### archeticture

```mermaid
flowchart TD;
    A[Redshift] -->|UNLOAD SQL (:run_date)| B[S3 Raw Data<br/>s3://<DataBucketName>/trust_scoring/raw/...]
    B --> C[ECS Fargate Task<br/>SpanCat Scorer]
    C -->|Scored Parquet| D[S3 Scored Data<br/>s3://<DataBucketName>/trust_scoring/scored/...]
    D --> E[SNS Topic]
    E --> F[📧 Email Notification]
```

### Input
- Data source: **Amazon Redshift** (workgroup + database stored in SSM).  
- SQL: stored in SSM parameter `/trust_scoring/sql` (must include `:run_date` placeholder).

### Raw export
- **Bucket:** created by this stack (see CloudFormation output `DataBucketName`).  
- **Prefix:**  s3://<DataBucketName>/trust_scoring/raw/run_date=<RUN_DATE>/run_id=<RUN_ID>/batch_000.parquet


### Scoring
- **Container:** built from `docker/spancat/` (see [docker/](docker/spancat)).  
- **Models:** downloaded from `aws-emr-studio-977903982786-us-east-1/ECU-trust-subdomains/...`.  
- **Process:** applies SpanCat models to each row (expects `cleaned_comment` field).

### Scored output
- **Bucket:** same as raw (the stack-managed bucket).  
- **Prefix:**  s3://<DataBucketName>/trust_scoring/scored/run_id=<RUN_ID>/part.parquet


### Notification
- **SNS topic:** created by this stack (see output `NotifyTopicArn`).  
- **Email:** subscribe in the input field as var "email" (eg, in json input: "email": "user@pephealth.ai")
- Email includes run date, run ID, up_id, and the S3 prefix with results.
- unsure if this feature is currently functional... i have yet to receive an email

---

## 🚫 Safety

This pipeline **does not overwrite** outputs from your existing script:

- **Original script**:  
`s3://pephealth-data/trust_scoring/scored/batch_<N>.parquet`  

- **This pipeline**:  
`s3://<DataBucketName>/trust_scoring/scored/run_id=<RUN_ID>/part.parquet`  

Different bucket and naming scheme → no collisions.

---

## 🛠️ Deployment

### Prerequisites
- Node.js 18+
- AWS CDK v2 (`npm i -g aws-cdk@2`)
- Docker (for building the SpanCat container)
- AWS CLI configured with pep creds

### Deploy
```bash
# bootstrap CDK (first time in account/region)
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>

# build project
npm install
npm run build

# synthesize template
cdk synth

# deploy stack
cdk deploy
```

### Outputs

After deployment you’ll see:
DataBucketName → S3 bucket used for raw + scored data
NotifyTopicArn → SNS topic for run completion notifications
StateMachineArn → Step Functions ARN for running jobs

## ▶️ Running the Pipeline
### Manual run
In AWS Console → Step Functions → your state machine → Start execution with:
```json
{
  "run_date": "2025-09-26",
  "run_id": "manual-001",
  "email": "user@example.com",
  "up_id": 7168
}
```
- run_date replaces :run_date in the SQL query.
- run_id namespaces the output paths in S3.
- email is the email that will be notified when run is complete
- up_id is for the SQL query, 7168 (in the example above) is tanner health. Please find the relevat up_id and avoid running the pipeline using the same id
⚠️ the SQL query pulls ALL data from the up_id - ensure that is what you want. if it isn't then clone the repo, edit the query, and upload changes to SSM using:
```bash
aws ssm put-parameter --region us-east-2 \
  --name /trust_scoring/sql --type String --overwrite \
  --value "$(< sql/trust_source.sql)"
```

or via aws cli:

```bash
SM_ARN=$(aws cloudformation describe-stacks --region us-east-2 --stack-name TrustPipelineStack \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)

aws stepfunctions start-execution \
  --region us-east-2 \
  --state-machine-arn "$SM_ARN" \
  --name run-2025-09-24-01 \
  --input '{"run_date":"2025-09-26","run_id":"manual-001", "email": "marah.shahin@pephealth.ai", "up_id": 7168}'
  ```

### Scheduled / cron run
(not implemented) can add an EventBridge (CloudWatch Events) rule to trigger the state machine on a cron (e.g., daily).

## ⚙️ Configuration & Parameters

The stack relies on a number of SSM parameters and JSON configuration files:

### SSM Parameters
- /trust_scoring/sql → Redshift query (with :run_date)
- /trust_scoring/data_bucket → data bucket name for raw/scored data
- /trust_scoring/notify_topic_arn → SNS topic ARN
- /trust_scoring/redshift/workgroup → Redshift workgroup
- /trust_scoring/redshift/database → Redshift database
- /trust_scoring/redshift/unload_role_arn → IAM role for UNLOAD to S3

### Models & Thresholds
- Defined in docker/spancat/models.json and thresholds.json.
- You can move these to S3/SSM for runtime configurability.


## 🔐 IAM & Permissions
- The Redshift UNLOAD IAM role must be allowed to write to the data bucket
- ECS Task Role must read raw data, read models bucket, and write scored output
- Lambda functions (export, notify) must have permission to read SSM, call Redshift Data API, publish to SNS, etc.
- Ensure that the ECS task role has S3 read permissions to the models bucket (for example, s3://aws-emr-studio-***/ECU-trust-subdomains/*)
- You may restrict access (via bucket policies, VPC endpoints) to ensure data is not publicly accessible

⚠️ Make sure to grant the ECS task role read access to the models bucket:
s3://aws-emr-studio-977903982786-us-east-1/ECU-trust-subdomains/*


## Observability & Monitoring
- CloudWatch Logs for all Lambda functions and ECS containers
- Step Functions UI & execution history for visual tracing
- SNS / email notifications as basic alerting
- You may extend with custom metrics (e.g. number of rows processed, number of spans scored)
- Add alarms on failures, high latencies, or missing runs


## Contributing / Extending
- add new SpanCat models by updating models.json and configuring corresponding thresholds
- migrate part of logic (SQL, pre-/post-processing) from the legacy scripts repo or ECU-Trust
- ensure that any new components (e.g. additional validation, fallback handling) follow the existing Step Functions state machine
- add unit / integration tests under test/ for new logic
- document new SSM parameters if needed
- SQL query could be a bit more dynamic and flow around this could be smarter - eg if we're running the script on tanners up_id, it will take all data from there but really we only want to score a comment once so ideally, we should keep a log somewhere and if the same up_id is used then the query updates to only take data that hasnt been scored... and i guess at that point the email should outline what the pipeline did so it may say, "already ran for 5000 comment_unique_key's which can be found in xyz bucket...(?) completed scoring for 200 comment_unique_key's that can be found in "<scored/..>"


## 📚 Useful Commands
```bash
# view current outputs
cdk outputs

# run build + synth
npm run build && cdk synth

# destroy the stack (removes resources but keeps S3 bucket if RETAIN)
cdk destroy
```
## Acknowledgements & References
This project is heavily inspired by / ported from:

- [PEPhealth/scripts](https://github.com/PEPhealth/scripts/tree/feature/EN-483-Move-ECU-ETL-to-Github) — branch feature/EN-483-Move-ECU-ETL-to-Github, mostly ecu_elt_trust & ecu_etl_script
- [PEPhealth/ECU-Trust](https://github.com/PEPhealth/ECU-Trust)

## Summary
This pipeline gives you:
- A repeatable, safe workflow for Redshift → SpanCat → S3 → Notification.
- Config-driven setup (SSM params).
- Clean separation from the original SQS-driven script.
- Fully managed AWS services (serverless, no EC2).
