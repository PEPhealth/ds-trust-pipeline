import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
//import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
//import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
//import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
//import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
//import * as lambdaPython from '@aws-cdk/aws-lambda-python-alpha';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';


import * as fs from 'fs';
import * as path from 'path';

export class TrustPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- Ensure S3 bucket is co-located with Redshift ---
    // Pass "-c redshiftRegion=<region>" on deploy, or it defaults to this stack's region.
    //const redshiftRegion = this.node.tryGetContext('redshiftRegion') ?? Stack.of(this).region;

    // Hard fail if you're deploying the stack to a different region than Redshift.
    //if (Stack.of(this).region !== redshiftRegion) {
    //  throw new Error(
    //    `This stack region (${Stack.of(this).region}) must match your Redshift region (${redshiftRegion}) so the S3 UNLOAD bucket is co-located. ` +
    //    `Re-run: cdk deploy --region ${redshiftRegion} -c redshiftRegion=${redshiftRegion}`
    //  );
    //}

    // ---- S3 bucket for data (raw + scored) ----
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- SNS topic (email) ----
    const topic = new sns.Topic(this, 'NotifyTopic', { });
    topic.addSubscription(new subs.EmailSubscription('marah.shahin@pephealth.ai'));

    // ---- SSM params (config-driven) ----
    //const pSql         = new ssm.StringParameter(this, 'ParamSql',         { parameterName: '/trust_scoring/sql', stringValue: "$(cat trust_source.sql)"}); // 'SELECT * FROM my_schema.my_table WHERE event_date = :run_date' });
    //const pSqlName = '/trust_scoring/sql';
    //const pSql = ssm.StringParameter.fromStringParameterName(this, 'ParamSql', pSqlName);
    // const pSql         = new ssm.StringParameter(this, 'ParamSql',         { parameterName: '/trust_scoring/sql', stringValue: "$(cat trust_source.sql)"});
    //const pSql = ssm.StringParameter.fromStringParameterName(this, 'ParamSql', pSqlName);
    // Read the SQL file at synth time and store it in SSM
    const sqlPath = path.join(__dirname, '..', 'sql/trust_source.sql'); // adjust if your file lives elsewhere
    const sqlText = fs.readFileSync(sqlPath, 'utf8');

    const pSql = new ssm.StringParameter(this, 'ParamSql', {
      parameterName: '/trust_scoring/sql',
      stringValue: sqlText, // actual SQL content
    });

    const secretName = 'redshift-access-creds-us-east-2';
    // Allow both the “friendly name” ARN and the suffixed ARN form
    const secretArnNoSuffix =
      `arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:${secretName}`;
    const secretArnWithSuffix =
      `arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:${secretName}*`;


    //const pDataBucket  = new ssm.StringParameter(this, 'ParamDataBucket',  { parameterName: '/trust_scoring/data_bucket', stringValue: 'pephealth-data'}); // dataBucket.bucketName
    const pDataBucket  = new ssm.StringParameter(this, 'ParamDataBucket',  { parameterName: '/trust_scoring/data_bucket', stringValue: dataBucket.bucketName}); // 

    const pRsRegion = new ssm.StringParameter(this, 'ParamRsRegion', {
      parameterName: '/trust_scoring/redshift/region',
      stringValue: 'us-east-2', //changer to var later
    });
    const pTopicArn    = new ssm.StringParameter(this, 'ParamTopicArn',    { parameterName: '/trust_scoring/notify_topic_arn', stringValue: topic.topicArn });

    const pWorkgroup   = new ssm.StringParameter(this, 'ParamRsWorkgroup', { parameterName: '/trust_scoring/redshift/workgroup', stringValue: 'mini-pep' });
    const pDatabase = new ssm.StringParameter(this, 'ParamRsDatabase',  { parameterName: '/trust_scoring/redshift/database',  stringValue: 'dev' });

    // Role Redshift will assume in UNLOAD (grants write to RAW prefix)
    const unloadRole = new iam.Role(this, 'RedshiftUnloadRole', {
      assumedBy: new iam.PrincipalWithConditions(
        new iam.CompositePrincipal(
          new iam.ServicePrincipal('redshift.amazonaws.com'),
          new iam.ServicePrincipal('redshift-serverless.amazonaws.com')
        ),
        {} // add conditions if you want to restrict
      ),
      description: 'Role used by Redshift UNLOAD to write to S3',
    });
    dataBucket.grantPut(unloadRole); // writes to bucket
    const pUnloadRole = new ssm.StringParameter(this, 'ParamUnloadRoleArn', { parameterName: '/trust_scoring/redshift/unload_role_arn', stringValue: unloadRole.roleArn });
    
    // Writes under trust_scoring/raw/*
    dataBucket.grantWrite(unloadRole, 'trust_scoring/raw/*');

    // List the bucket (limited to the raw prefix)
    unloadRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [dataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['trust_scoring/raw/*'] } },
    }));
    
    // ---- VPC & ECS cluster ----
    //const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 0 }); // simple + cheap
    //const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    // Prefer the default VPC (no new IGW/NAT created). If you deleted it, pass -c vpcId=<vpc-xxxx>.
    const vpcId = this.node.tryGetContext('vpcId') as string | undefined;

    const vpc = vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId })
      : ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // ---- Build the scorer container image from local Docker context ----
    //const scorerAsset = new ecrAssets.DockerImageAsset(this, 'ScorerImage', {
    //  directory: 'docker/spancat',
    //  platform: ecrAssets.Platform.LINUX_AMD64, // <- force linux/amd64
    //});
    //const scorerImage = ecs.ContainerImage.fromDockerImageAsset(scorerAsset);

    // use the ECR image built by CodeBuild
    const scorerImage = ecs.ContainerImage.fromRegistry(
      '977903982786.dkr.ecr.us-east-2.amazonaws.com/ds-trust-spancat:latest'
    );


    const taskRole = new iam.Role(this, 'FargateTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Access S3 and SSM
    dataBucket.grantReadWrite(taskRole);
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: ['*'] // tighten with specific ARNs if you like
    }));
    // Allow ECS task to read models from the models bucket
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      resources: [
        // List bucket itself
        "arn:aws:s3:::aws-emr-studio-977903982786-us-east-1",
        // Objects under the ECU-trust-subdomains prefix
        "arn:aws:s3:::aws-emr-studio-977903982786-us-east-1/ECU-trust-subdomains/*"
      ]
    }));
    // If models live in another bucket, grant read here as well.

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 4096,                // 4 vCPU
      memoryLimitMiB: 30720, // 16 GB RAM 16384 didnt work, upped to 30gb
      ephemeralStorageGiB: 50, // optional, room for model cache/temp
      taskRole,
    });
    // Allow the execution role to pull from your ECR repo
    const repo = ecr.Repository.fromRepositoryName(this, 'SpancatRepo', 'ds-trust-spancat');
    repo.grantPull(taskDef.obtainExecutionRole());

    const container = taskDef.addContainer('spancat', {
      image: scorerImage,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'spancat' }),
      environment: {
        // defaults; Step Functions overrides at run time
        TEXT_COL: 'cleaned_comment',
        AWS_DEFAULT_REGION: Stack.of(this).region,
        // If your code needs to download the trained models from S3, set this:
        MODELS_S3_PREFIX: 's3://aws-emr-studio-977903982786-us-east-1/ECU-trust-subdomains/',
      },
    });

    // Import your existing secret by name (same region: us-east-2)
    const dbSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'RedshiftAccessSecret',
      'redshift-access-creds-us-east-2'
    );


    // ---- Export Lambda (Redshift Data API + UNLOAD) ----
        // ---- Export Lambda (Redshift Data API + UNLOAD) ----
    const exportFn = new lambda.Function(this, 'ExportFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambda/export_redshift'), // directory with handler.py
      timeout: Duration.minutes(5),
      environment: {
        PARAM_SQL: pSql.parameterName,
        PARAM_DATA_BUCKET: pDataBucket.parameterName,
        PARAM_UNLOAD_ROLE: pUnloadRole.parameterName,
        PARAM_RS_WORKGROUP: pWorkgroup.parameterName,
        PARAM_RS_DATABASE: pDatabase.parameterName,
        RS_REGION: Stack.of(this).region,
        DB_SECRET_ARN: dbSecret.secretArn,
        // DB_SECRET_ARN if you use Secrets Manager auth:
        // DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:977903982786:secret:redshift-access-creds-us-east-2'
      },
    });

    // Let the Export Lambda read the secret
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [dbSecret.secretArn],
    }));
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
      resources: [secretArnNoSuffix, secretArnWithSuffix],
    }));

    // Permissions for Redshift Data API & SSM
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['redshift-data:ExecuteStatement','redshift-data:DescribeStatement','redshift-data:GetStatementResult'],
      resources: ['*'] // you can scope to your workgroup/database
    }));
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter','ssm:GetParameters'],
      resources: [pSql.parameterArn, pDataBucket.parameterArn, pUnloadRole.parameterArn, pWorkgroup.parameterArn, pDatabase.parameterArn, pRsRegion.parameterArn]
    }));
    // Allow Export Lambda to obtain temporary DB creds for Redshift Serverless
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['redshift-serverless:GetCredentials'],
      resources: [
        // All workgroups in this account/region (tighten to a specific workgroup ARN later if you like)
        `arn:aws:redshift-serverless:${Stack.of(this).region}:${Stack.of(this).account}:workgroup/*`,
      ],
    }));

    //allow describing/listing workgroups by name
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['redshift-serverless:GetWorkgroup', 'redshift-serverless:ListWorkgroups'],
      resources: ['*'],
    }));


    dataBucket.grantReadWrite(exportFn); // for list/verify

    // ---- Notify Lambda ----
    const notifyFn = new lambda.Function(this, 'NotifyFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambda/notify'), // directory with handler.py
      timeout: Duration.seconds(30),
      environment: {
        PARAM_SNS_TOPIC: pTopicArn.parameterName,
        PARAM_DATA_BUCKET: pDataBucket.parameterName,
      },
    });
    notifyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [pTopicArn.parameterArn, pDataBucket.parameterArn]
    }));
    topic.grantPublish(notifyFn);
   // ------

    // ---- Step Functions: Export -> Run Fargate -> Notify ----
    const runTask = new tasks.EcsRunTask(this, 'RunScorer', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition: taskDef,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      assignPublicIp: true,
      containerOverrides: [{
        containerDefinition: container,
        environment: [
          { // from Export lambda result
            name: 'INPUT_PREFIX',
            value: sfn.JsonPath.stringAt('$.Export.Payload.s3_prefix'),
          },
          { // build scored prefix
            name: 'OUTPUT_PREFIX',
            value: sfn.JsonPath.format(
              's3://{}/trust_scoring/scored/run_id={}/',
              dataBucket.bucketName,
              sfn.JsonPath.stringAt('$.Export.Payload.run_id'),
            ),
          },
        ],
      }],
      // (optionally) capture the ECS result without overwriting the whole context:
      resultPath: '$.Ecs',
    });
    // Export: keep under $.Export
    const exportTask = new tasks.LambdaInvoke(this, 'Export', {
      lambdaFunction: exportFn,
      resultPath: '$.Export',   // <- store here
      outputPath: '$',          // keep whole context
    });

    // Run task: (see above) resultPath: '$.Ecs'

    // Notify: pass what you need explicitly
    const notifyTask = new tasks.LambdaInvoke(this, 'Notify', {
      lambdaFunction: notifyFn,
      // Pass the entire state (includes run input like "email", plus Export/Ecs)
      payload: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const definition = exportTask.next(runTask).next(notifyTask);

    const sm = new sfn.StateMachine(this, 'TrustScoringSm', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(2)
    });

    // outputs
    new CfnOutput(this, 'StateMachineArn', { value: sm.stateMachineArn });
    new CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new CfnOutput(this, 'NotifyTopicArn', { value: topic.topicArn });
  }
}
