# Trust Pipeline (AWS CDK)

This project defines a reusable AWS Step Functions pipeline for running **spaCy SpanCat trust scoring models** on data from **Amazon Redshift**.  

It automates the workflow:

1. **Export from Redshift** → runs a SQL query and UNLOADs results to S3 (Parquet).  
2. **Score with SpanCat** → processes exported rows in an ECS Fargate container, applying multiple models.  
3. **Write results** → saves scored spans back to S3.  
4. **Notify** → sends an SNS email when the run is complete.

---

## 📂 Data Flow

### Input
- Data source: **Amazon Redshift** (workgroup + database stored in SSM).  
- SQL: stored in SSM parameter `/trust_scoring/sql` (must include `:run_date` placeholder).

### Raw export
- **Bucket:** created by this stack (see CloudFormation output `DataBucketName`).  
- **Prefix:** # 🧩 Trust Pipeline (AWS CDK)

This project defines a reusable AWS Step Functions pipeline for running **spaCy SpanCat trust scoring models** on data from **Amazon Redshift**.  

It automates the workflow:

1. **Export from Redshift** → runs a SQL query and UNLOADs results to S3 (Parquet).  
2. **Score with SpanCat** → processes exported rows in an ECS Fargate container, applying multiple models.  
3. **Write results** → saves scored spans back to S3.  
4. **Notify** → sends an SNS email when the run is complete.

---

## 📂 Data Flow

```mermaid
flowchart TD
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
- **Email:** subscribe in the console or via CDK.  
- Email includes run date, run ID, and the S3 prefix with results.

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
- Docker (for building the scorer image)
- AWS CLI configured

### Deploy
```bash
# bootstrap CDK (first time in account/region)
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>

# build project
npm run build

# synthesize template
cdk synth

# deploy stack
cdk deploy
```

### Outputs

After deploy you’ll see:
DataBucketName → S3 bucket used for raw + scored data.
NotifyTopicArn → SNS topic for notifications.
StateMachineArn → Step Functions ARN for running jobs.

## ▶️ Running the Pipeline
### Manual run
In AWS Console → Step Functions → your state machine → Start execution with:
```json
{
  "run_date": "2025-09-17",
  "run_id": "manual-001"
}
```
- run_date replaces :run_date in the SQL query.
- run_id namespaces the output paths in S3.

or via cli:

bash ```
SM_ARN=$(aws cloudformation describe-stacks --region us-east-2 \
  --stack-name TrustPipelineStack \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)

aws stepfunctions start-execution \
  --region us-east-2 \
  --state-machine-arn "$SM_ARN" \
  --name run-$(date +%F-%H%M%S) \ 
  --input '{
    "run_id": "manual-010",
    "run_date": "2025-09-25",
    "email": "marah.shahin@pephealth.ai",
    "up_id": 7168
  }'
  ```

### Scheduled run
Add an EventBridge rule to trigger the state machine on a cron (e.g., daily).

## ⚙️ Configuration

### SSM Parameters
- /trust_scoring/sql → Redshift query (with :run_date).
- /trust_scoring/data_bucket → data bucket name.
- /trust_scoring/notify_topic_arn → SNS topic ARN.
- /trust_scoring/redshift/workgroup → Redshift workgroup.
- /trust_scoring/redshift/database → Redshift database.
- /trust_scoring/redshift/unload_role_arn → IAM role for UNLOAD to S3.

### Models & Thresholds
- Defined in docker/spancat/models.json and thresholds.json.
- You can move these to S3/SSM for runtime configurability.


## 🔐 IAM & Permissions
- Redshift UNLOAD role → can write to data bucket.
- ECS task role → can read raw data, write scored data, and read models bucket.
- Export Lambda → can call Redshift Data API + read SSM.
- Notify Lambda → can read SSM + publish to SNS.

⚠️ Make sure to grant the ECS task role read access to the models bucket:
s3://aws-emr-studio-977903982786-us-east-1/ECU-trust-subdomains/*


## 📊 Observability
- CloudWatch Logs → all Lambdas and ECS tasks.
- Step Functions → visual execution history.
- SNS email → run completion notification.
Optional: add metrics for rows processed and spans generated.


## 🚀 Next Steps
1. Subscribe your email to the SNS topic.
2. Update /trust_scoring/sql in SSM with your actual query.
3. Add S3 read permissions for the ECS task role on the models bucket.
4. Test a run with a recent run_date.
5. Verify raw + scored files in S3 and check the notification email.


## 📚 Useful Commands
```bash
# view current outputs
cdk outputs

# run build + synth
npm run build && cdk synth

# destroy the stack (removes resources but keeps S3 bucket if RETAIN)
cdk destroy
```

## Summary
This pipeline gives you:
- A repeatable, safe workflow for Redshift → SpanCat → S3 → Notification.
- Config-driven setup (SSM params).
- Clean separation from your original SQS-driven script.
- Fully managed AWS services (serverless, no EC2).