"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrustPipelineStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaPython = __importStar(require("@aws-cdk/aws-lambda-python-alpha"));
const sfn = __importStar(require("aws-cdk-lib/aws-stepfunctions"));
const tasks = __importStar(require("aws-cdk-lib/aws-stepfunctions-tasks"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
class TrustPipelineStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ---- S3 bucket for data (raw + scored) ----
        const dataBucket = new s3.Bucket(this, 'DataBucket', {
            versioned: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
        });
        // ---- SNS topic (email) ----
        const topic = new sns.Topic(this, 'NotifyTopic', {});
        // OPTIONAL: subscribe your email here or do it later in console
        // topic.addSubscription(new subs.EmailSubscription('you@yourcompany.com'));
        // ---- SSM params (config-driven) ----
        const pSql = new ssm.StringParameter(this, 'ParamSql', { parameterName: '/trust_scoring/sql', stringValue: 'SELECT * FROM my_schema.my_table WHERE event_date = :run_date' });
        const pDataBucket = new ssm.StringParameter(this, 'ParamDataBucket', { parameterName: '/trust_scoring/data_bucket', stringValue: dataBucket.bucketName });
        const pTopicArn = new ssm.StringParameter(this, 'ParamTopicArn', { parameterName: '/trust_scoring/notify_topic_arn', stringValue: topic.topicArn });
        const pWorkgroup = new ssm.StringParameter(this, 'ParamRsWorkgroup', { parameterName: '/trust_scoring/redshift/workgroup', stringValue: '<YOUR_REDSHIFT_WORKGROUP>' });
        const pDatabase = new ssm.StringParameter(this, 'ParamRsDatabase', { parameterName: '/trust_scoring/redshift/database', stringValue: '<YOUR_DB_NAME>' });
        // Role Redshift will assume in UNLOAD (grants write to RAW prefix)
        const unloadRole = new iam.Role(this, 'RedshiftUnloadRole', {
            assumedBy: new iam.PrincipalWithConditions(new iam.CompositePrincipal(new iam.ServicePrincipal('redshift.amazonaws.com'), new iam.ServicePrincipal('redshift-serverless.amazonaws.com')), {} // add conditions if you want to restrict
            ),
            description: 'Role used by Redshift UNLOAD to write to S3',
        });
        dataBucket.grantPut(unloadRole); // writes to bucket
        const pUnloadRole = new ssm.StringParameter(this, 'ParamUnloadRoleArn', { parameterName: '/trust_scoring/redshift/unload_role_arn', stringValue: unloadRole.roleArn });
        // ---- VPC & ECS cluster ----
        const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 0 }); // simple + cheap
        const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
        // ---- Build the scorer container image from local Docker context ----
        const scorerImage = ecs.ContainerImage.fromAsset('docker/spancat'); // Dockerfile in that folder
        const taskRole = new iam.Role(this, 'FargateTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        // Access S3 and SSM
        dataBucket.grantReadWrite(taskRole);
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
            resources: ['*'] // tighten with specific ARNs if you like
        }));
        // If models live in another bucket, grant read here as well.
        const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
            cpu: 1024, memoryLimitMiB: 2048, taskRole
        });
        const container = taskDef.addContainer('spancat', {
            image: scorerImage,
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'spancat' }),
            environment: {
                // defaults; Step Functions overrides at run time
                TEXT_COL: 'cleaned_comment'
            }
        });
        // ---- Export Lambda (Redshift Data API + UNLOAD) ----
        const exportFn = new lambdaPython.PythonFunction(this, 'ExportFn', {
            entry: 'lambda/export_redshift',
            index: 'handler.py',
            runtime: lambda.Runtime.PYTHON_3_12,
            timeout: aws_cdk_lib_1.Duration.minutes(5),
            environment: {
                PARAM_SQL: pSql.parameterName,
                PARAM_DATA_BUCKET: pDataBucket.parameterName,
                PARAM_UNLOAD_ROLE: pUnloadRole.parameterName,
                PARAM_RS_WORKGROUP: pWorkgroup.parameterName,
                PARAM_RS_DATABASE: pDatabase.parameterName,
            }
        });
        // Permissions for Redshift Data API & SSM
        exportFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['redshift-data:ExecuteStatement', 'redshift-data:DescribeStatement', 'redshift-data:GetStatementResult'],
            resources: ['*'] // you can scope to your workgroup/database
        }));
        exportFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: [pSql.parameterArn, pDataBucket.parameterArn, pUnloadRole.parameterArn, pWorkgroup.parameterArn, pDatabase.parameterArn]
        }));
        dataBucket.grantReadWrite(exportFn); // for list/verify
        // ---- Notify Lambda ----
        const notifyFn = new lambdaPython.PythonFunction(this, 'NotifyFn', {
            entry: 'lambda/notify',
            index: 'handler.py',
            runtime: lambda.Runtime.PYTHON_3_12,
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            environment: {
                PARAM_SNS_TOPIC: pTopicArn.parameterName,
                PARAM_DATA_BUCKET: pDataBucket.parameterName
            }
        });
        notifyFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'], resources: [pTopicArn.parameterArn, pDataBucket.parameterArn]
        }));
        topic.grantPublish(notifyFn);
        // ---- Step Functions: Export -> Run Fargate -> Notify ----
        const exportTask = new tasks.LambdaInvoke(this, 'Export', {
            lambdaFunction: exportFn,
            outputPath: '$' // keep full
        });
        const runTask = new tasks.EcsRunTask(this, 'RunScorer', {
            integrationPattern: sfn.IntegrationPattern.RUN_JOB, // wait for task to finish
            cluster,
            taskDefinition: taskDef,
            launchTarget: new tasks.EcsFargateLaunchTarget(),
            assignPublicIp: true, // simple; or use NAT/private subnets
            containerOverrides: [{
                    containerDefinition: container,
                    environment: [
                        {
                            name: 'INPUT_PREFIX',
                            value: sfn.JsonPath.stringAt('$.Payload.s3_prefix')
                        },
                        {
                            name: 'OUTPUT_PREFIX',
                            value: sfn.JsonPath.stringAt(`States.Format('s3://{}/trust_scoring/scored/run_id={}/', '${dataBucket.bucketName}', '$.Payload.run_id')`)
                        }
                    ]
                }]
        });
        const notifyTask = new tasks.LambdaInvoke(this, 'Notify', {
            lambdaFunction: notifyFn,
            payload: sfn.TaskInput.fromObject({ Export: sfn.JsonPath.entirePayload }),
            resultPath: sfn.JsonPath.DISCARD
        });
        const definition = exportTask.next(runTask).next(notifyTask);
        const sm = new sfn.StateMachine(this, 'TrustScoringSm', {
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: aws_cdk_lib_1.Duration.hours(2)
        });
        // outputs
        new aws_cdk_lib_1.CfnOutput(this, 'StateMachineArn', { value: sm.stateMachineArn });
        new aws_cdk_lib_1.CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
        new aws_cdk_lib_1.CfnOutput(this, 'NotifyTopicArn', { value: topic.topicArn });
    }
}
exports.TrustPipelineStack = TrustPipelineStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHJ1c3QtcGlwZWxpbmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ0cnVzdC1waXBlbGluZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFvRjtBQUVwRix1REFBeUM7QUFFekMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFHM0MsK0RBQWlEO0FBRWpELCtFQUFpRTtBQUNqRSxtRUFBcUQ7QUFDckQsMkVBQTZEO0FBQzdELHlEQUEyQztBQUMzQyx5REFBMkM7QUFHM0MsTUFBYSxrQkFBbUIsU0FBUSxtQkFBSztJQUMzQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWtCO1FBQzFELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDhDQUE4QztRQUM5QyxNQUFNLFVBQVUsR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNuRCxTQUFTLEVBQUUsSUFBSTtZQUNmLGlCQUFpQixFQUFFLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxTQUFTO1lBQ2pELFVBQVUsRUFBRSxFQUFFLENBQUMsZ0JBQWdCLENBQUMsVUFBVTtZQUMxQyxVQUFVLEVBQUUsSUFBSTtZQUNoQixhQUFhLEVBQUUsMkJBQWEsQ0FBQyxNQUFNO1NBQ3BDLENBQUMsQ0FBQztRQUVILDhCQUE4QjtRQUM5QixNQUFNLEtBQUssR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRSxFQUFHLENBQUMsQ0FBQztRQUN0RCxnRUFBZ0U7UUFDaEUsNEVBQTRFO1FBRTVFLHVDQUF1QztRQUN2QyxNQUFNLElBQUksR0FBVyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBVSxFQUFFLGFBQWEsRUFBRSxvQkFBb0IsRUFBRSxXQUFXLEVBQUUs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QUM7UUFFN0QsTUFBTSxFQUFFLEdBQUcsSUFBSSxHQUFHLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUN0RCxjQUFjLEVBQUUsR0FBRyxDQUFDLGNBQWMsQ0FBQyxhQUFhLENBQUMsVUFBVSxDQUFDO1lBQzVELE9BQU8sRUFBRSxzQkFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7U0FDM0IsQ0FBQyxDQUFDO1FBRUgsVUFBVTtRQUNWLElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUUsRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLGVBQWUsRUFBRSxDQUFDLENBQUM7UUFDdEUsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRSxFQUFFLEtBQUssRUFBRSxVQUFVLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztRQUN4RSxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO0lBQ25FLENBQUM7Q0FDRjtBQTVKRCxnREE0SkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBTdGFjaywgU3RhY2tQcm9wcywgRHVyYXRpb24sIENmbk91dHB1dCwgUmVtb3ZhbFBvbGljeSB9IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGttcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mta21zJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVjc1BhdHRlcm5zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MtcGF0dGVybnMnO1xuaW1wb3J0ICogYXMgZWNyQXNzZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3ItYXNzZXRzJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGxhbWJkYU5vZGUgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0ICogYXMgbGFtYmRhUHl0aG9uIGZyb20gJ0Bhd3MtY2RrL2F3cy1sYW1iZGEtcHl0aG9uLWFscGhhJztcbmltcG9ydCAqIGFzIHNmbiBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3RlcGZ1bmN0aW9ucyc7XG5pbXBvcnQgKiBhcyB0YXNrcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3RlcGZ1bmN0aW9ucy10YXNrcyc7XG5pbXBvcnQgKiBhcyBzc20gZnJvbSAnYXdzLWNkay1saWIvYXdzLXNzbSc7XG5pbXBvcnQgKiBhcyBzbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucyc7XG5pbXBvcnQgKiBhcyBzdWJzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMtc3Vic2NyaXB0aW9ucyc7XG5cbmV4cG9ydCBjbGFzcyBUcnVzdFBpcGVsaW5lU3RhY2sgZXh0ZW5kcyBTdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gLS0tLSBTMyBidWNrZXQgZm9yIGRhdGEgKHJhdyArIHNjb3JlZCkgLS0tLVxuICAgIGNvbnN0IGRhdGFCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdEYXRhQnVja2V0Jywge1xuICAgICAgdmVyc2lvbmVkOiB0cnVlLFxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gU05TIHRvcGljIChlbWFpbCkgLS0tLVxuICAgIGNvbnN0IHRvcGljID0gbmV3IHNucy5Ub3BpYyh0aGlzLCAnTm90aWZ5VG9waWMnLCB7IH0pO1xuICAgIC8vIE9QVElPTkFMOiBzdWJzY3JpYmUgeW91ciBlbWFpbCBoZXJlIG9yIGRvIGl0IGxhdGVyIGluIGNvbnNvbGVcbiAgICAvLyB0b3BpYy5hZGRTdWJzY3JpcHRpb24obmV3IHN1YnMuRW1haWxTdWJzY3JpcHRpb24oJ3lvdUB5b3VyY29tcGFueS5jb20nKSk7XG5cbiAgICAvLyAtLS0tIFNTTSBwYXJhbXMgKGNvbmZpZy1kcml2ZW4pIC0tLS1cbiAgICBjb25zdCBwU3FsICAgICAgICAgPSBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCAnUGFyYW1TcWwnLCAgICAgICAgIHsgcGFyYW1ldGVyTmFtZTogJy90cnVzdF9zY29yaW5nL3NxbCcsIHN0cmluZ1ZhbHVlOiAnU0VMRUNUICogRlJPTSBteV9zY2hlbWEubXlfdGFibGUgV0hFUkUgZXZlbnRfZGF0ZSA9IDpydW5fZGF0ZScgfSk7XG4gICAgY29uc3QgcERhdGFCdWNrZXQgID0gbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgJ1BhcmFtRGF0YUJ1Y2tldCcsICB7IHBhcmFtZXRlck5hbWU6ICcvdHJ1c3Rfc2NvcmluZy9kYXRhX2J1Y2tldCcsIHN0cmluZ1ZhbHVlOiBkYXRhQnVja2V0LmJ1Y2tldE5hbWUgfSk7XG4gICAgY29uc3QgcFRvcGljQXJuICAgID0gbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgJ1BhcmFtVG9waWNBcm4nLCAgICB7IHBhcmFtZXRlck5hbWU6ICcvdHJ1c3Rfc2NvcmluZy9ub3RpZnlfdG9waWNfYXJuJywgc3RyaW5nVmFsdWU6IHRvcGljLnRvcGljQXJuIH0pO1xuICAgIGNvbnN0IHBXb3JrZ3JvdXAgICA9IG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsICdQYXJhbVJzV29ya2dyb3VwJywgeyBwYXJhbWV0ZXJOYW1lOiAnL3RydXN0X3Njb3JpbmcvcmVkc2hpZnQvd29ya2dyb3VwJywgc3RyaW5nVmFsdWU6ICc8WU9VUl9SRURTSElGVF9XT1JLR1JPVVA+JyB9KTtcbiAgICBjb25zdCBwRGF0YWJhc2UgICAgPSBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCAnUGFyYW1Sc0RhdGFiYXNlJywgIHsgcGFyYW1ldGVyTmFtZTogJy90cnVzdF9zY29yaW5nL3JlZHNoaWZ0L2RhdGFiYXNlJywgIHN0cmluZ1ZhbHVlOiAnPFlPVVJfREJfTkFNRT4nIH0pO1xuXG4gICAgLy8gUm9sZSBSZWRzaGlmdCB3aWxsIGFzc3VtZSBpbiBVTkxPQUQgKGdyYW50cyB3cml0ZSB0byBSQVcgcHJlZml4KVxuICAgIGNvbnN0IHVubG9hZFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1JlZHNoaWZ0VW5sb2FkUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5QcmluY2lwYWxXaXRoQ29uZGl0aW9ucyhcbiAgICAgICAgbmV3IGlhbS5Db21wb3NpdGVQcmluY2lwYWwoXG4gICAgICAgICAgbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdyZWRzaGlmdC5hbWF6b25hd3MuY29tJyksXG4gICAgICAgICAgbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdyZWRzaGlmdC1zZXJ2ZXJsZXNzLmFtYXpvbmF3cy5jb20nKVxuICAgICAgICApLFxuICAgICAgICB7fSAvLyBhZGQgY29uZGl0aW9ucyBpZiB5b3Ugd2FudCB0byByZXN0cmljdFxuICAgICAgKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUm9sZSB1c2VkIGJ5IFJlZHNoaWZ0IFVOTE9BRCB0byB3cml0ZSB0byBTMycsXG4gICAgfSk7XG4gICAgZGF0YUJ1Y2tldC5ncmFudFB1dCh1bmxvYWRSb2xlKTsgLy8gd3JpdGVzIHRvIGJ1Y2tldFxuICAgIGNvbnN0IHBVbmxvYWRSb2xlID0gbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgJ1BhcmFtVW5sb2FkUm9sZUFybicsIHsgcGFyYW1ldGVyTmFtZTogJy90cnVzdF9zY29yaW5nL3JlZHNoaWZ0L3VubG9hZF9yb2xlX2FybicsIHN0cmluZ1ZhbHVlOiB1bmxvYWRSb2xlLnJvbGVBcm4gfSk7XG5cbiAgICAvLyAtLS0tIFZQQyAmIEVDUyBjbHVzdGVyIC0tLS1cbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnVnBjJywgeyBtYXhBenM6IDIsIG5hdEdhdGV3YXlzOiAwIH0pOyAvLyBzaW1wbGUgKyBjaGVhcFxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0NsdXN0ZXInLCB7IHZwYyB9KTtcblxuICAgIC8vIC0tLS0gQnVpbGQgdGhlIHNjb3JlciBjb250YWluZXIgaW1hZ2UgZnJvbSBsb2NhbCBEb2NrZXIgY29udGV4dCAtLS0tXG4gICAgY29uc3Qgc2NvcmVySW1hZ2UgPSBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUFzc2V0KCdkb2NrZXIvc3BhbmNhdCcpOyAvLyBEb2NrZXJmaWxlIGluIHRoYXQgZm9sZGVyXG5cbiAgICBjb25zdCB0YXNrUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRmFyZ2F0ZVRhc2tSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG4gICAgLy8gQWNjZXNzIFMzIGFuZCBTU01cbiAgICBkYXRhQnVja2V0LmdyYW50UmVhZFdyaXRlKHRhc2tSb2xlKTtcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3NzbTpHZXRQYXJhbWV0ZXInLCAnc3NtOkdldFBhcmFtZXRlcnMnLCAnc3NtOkdldFBhcmFtZXRlcnNCeVBhdGgnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10gLy8gdGlnaHRlbiB3aXRoIHNwZWNpZmljIEFSTnMgaWYgeW91IGxpa2VcbiAgICB9KSk7XG4gICAgLy8gSWYgbW9kZWxzIGxpdmUgaW4gYW5vdGhlciBidWNrZXQsIGdyYW50IHJlYWQgaGVyZSBhcyB3ZWxsLlxuXG4gICAgY29uc3QgdGFza0RlZiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdUYXNrRGVmJywge1xuICAgICAgY3B1OiAxMDI0LCBtZW1vcnlMaW1pdE1pQjogMjA0OCwgdGFza1JvbGVcbiAgICB9KTtcblxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRhc2tEZWYuYWRkQ29udGFpbmVyKCdzcGFuY2F0Jywge1xuICAgICAgaW1hZ2U6IHNjb3JlckltYWdlLFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7IHN0cmVhbVByZWZpeDogJ3NwYW5jYXQnIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgLy8gZGVmYXVsdHM7IFN0ZXAgRnVuY3Rpb25zIG92ZXJyaWRlcyBhdCBydW4gdGltZVxuICAgICAgICBURVhUX0NPTDogJ2NsZWFuZWRfY29tbWVudCdcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIC0tLS0gRXhwb3J0IExhbWJkYSAoUmVkc2hpZnQgRGF0YSBBUEkgKyBVTkxPQUQpIC0tLS1cbiAgICBjb25zdCBleHBvcnRGbiA9IG5ldyBsYW1iZGFQeXRob24uUHl0aG9uRnVuY3Rpb24odGhpcywgJ0V4cG9ydEZuJywge1xuICAgICAgZW50cnk6ICdsYW1iZGEvZXhwb3J0X3JlZHNoaWZ0JyxcbiAgICAgIGluZGV4OiAnaGFuZGxlci5weScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBQQVJBTV9TUUw6IHBTcWwucGFyYW1ldGVyTmFtZSxcbiAgICAgICAgUEFSQU1fREFUQV9CVUNLRVQ6IHBEYXRhQnVja2V0LnBhcmFtZXRlck5hbWUsXG4gICAgICAgIFBBUkFNX1VOTE9BRF9ST0xFOiBwVW5sb2FkUm9sZS5wYXJhbWV0ZXJOYW1lLFxuICAgICAgICBQQVJBTV9SU19XT1JLR1JPVVA6IHBXb3JrZ3JvdXAucGFyYW1ldGVyTmFtZSxcbiAgICAgICAgUEFSQU1fUlNfREFUQUJBU0U6IHBEYXRhYmFzZS5wYXJhbWV0ZXJOYW1lLFxuICAgICAgfVxuICAgIH0pO1xuICAgIC8vIFBlcm1pc3Npb25zIGZvciBSZWRzaGlmdCBEYXRhIEFQSSAmIFNTTVxuICAgIGV4cG9ydEZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3JlZHNoaWZ0LWRhdGE6RXhlY3V0ZVN0YXRlbWVudCcsJ3JlZHNoaWZ0LWRhdGE6RGVzY3JpYmVTdGF0ZW1lbnQnLCdyZWRzaGlmdC1kYXRhOkdldFN0YXRlbWVudFJlc3VsdCddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSAvLyB5b3UgY2FuIHNjb3BlIHRvIHlvdXIgd29ya2dyb3VwL2RhdGFiYXNlXG4gICAgfSkpO1xuICAgIGV4cG9ydEZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3NzbTpHZXRQYXJhbWV0ZXInLCdzc206R2V0UGFyYW1ldGVycyddLFxuICAgICAgcmVzb3VyY2VzOiBbcFNxbC5wYXJhbWV0ZXJBcm4sIHBEYXRhQnVja2V0LnBhcmFtZXRlckFybiwgcFVubG9hZFJvbGUucGFyYW1ldGVyQXJuLCBwV29ya2dyb3VwLnBhcmFtZXRlckFybiwgcERhdGFiYXNlLnBhcmFtZXRlckFybl1cbiAgICB9KSk7XG4gICAgZGF0YUJ1Y2tldC5ncmFudFJlYWRXcml0ZShleHBvcnRGbik7IC8vIGZvciBsaXN0L3ZlcmlmeVxuXG4gICAgLy8gLS0tLSBOb3RpZnkgTGFtYmRhIC0tLS1cbiAgICBjb25zdCBub3RpZnlGbiA9IG5ldyBsYW1iZGFQeXRob24uUHl0aG9uRnVuY3Rpb24odGhpcywgJ05vdGlmeUZuJywge1xuICAgICAgZW50cnk6ICdsYW1iZGEvbm90aWZ5JyxcbiAgICAgIGluZGV4OiAnaGFuZGxlci5weScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUEFSQU1fU05TX1RPUElDOiBwVG9waWNBcm4ucGFyYW1ldGVyTmFtZSxcbiAgICAgICAgUEFSQU1fREFUQV9CVUNLRVQ6IHBEYXRhQnVja2V0LnBhcmFtZXRlck5hbWVcbiAgICAgIH1cbiAgICB9KTtcbiAgICBub3RpZnlGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzc206R2V0UGFyYW1ldGVyJ10sIHJlc291cmNlczogW3BUb3BpY0Fybi5wYXJhbWV0ZXJBcm4sIHBEYXRhQnVja2V0LnBhcmFtZXRlckFybl1cbiAgICB9KSk7XG4gICAgdG9waWMuZ3JhbnRQdWJsaXNoKG5vdGlmeUZuKTtcblxuICAgIC8vIC0tLS0gU3RlcCBGdW5jdGlvbnM6IEV4cG9ydCAtPiBSdW4gRmFyZ2F0ZSAtPiBOb3RpZnkgLS0tLVxuICAgIGNvbnN0IGV4cG9ydFRhc2sgPSBuZXcgdGFza3MuTGFtYmRhSW52b2tlKHRoaXMsICdFeHBvcnQnLCB7XG4gICAgICBsYW1iZGFGdW5jdGlvbjogZXhwb3J0Rm4sXG4gICAgICBvdXRwdXRQYXRoOiAnJCcgLy8ga2VlcCBmdWxsXG4gICAgfSk7XG5cbiAgICBjb25zdCBydW5UYXNrID0gbmV3IHRhc2tzLkVjc1J1blRhc2sodGhpcywgJ1J1blNjb3JlcicsIHtcbiAgICAgIGludGVncmF0aW9uUGF0dGVybjogc2ZuLkludGVncmF0aW9uUGF0dGVybi5SVU5fSk9CLCAvLyB3YWl0IGZvciB0YXNrIHRvIGZpbmlzaFxuICAgICAgY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uOiB0YXNrRGVmLFxuICAgICAgbGF1bmNoVGFyZ2V0OiBuZXcgdGFza3MuRWNzRmFyZ2F0ZUxhdW5jaFRhcmdldCgpLFxuICAgICAgYXNzaWduUHVibGljSXA6IHRydWUsIC8vIHNpbXBsZTsgb3IgdXNlIE5BVC9wcml2YXRlIHN1Ym5ldHNcbiAgICAgIGNvbnRhaW5lck92ZXJyaWRlczogW3tcbiAgICAgICAgY29udGFpbmVyRGVmaW5pdGlvbjogY29udGFpbmVyLFxuICAgICAgICBlbnZpcm9ubWVudDogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIG5hbWU6ICdJTlBVVF9QUkVGSVgnLFxuICAgICAgICAgICAgdmFsdWU6IHNmbi5Kc29uUGF0aC5zdHJpbmdBdCgnJC5QYXlsb2FkLnMzX3ByZWZpeCcpXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBuYW1lOiAnT1VUUFVUX1BSRUZJWCcsXG4gICAgICAgICAgICB2YWx1ZTogc2ZuLkpzb25QYXRoLnN0cmluZ0F0KGBTdGF0ZXMuRm9ybWF0KCdzMzovL3t9L3RydXN0X3Njb3Jpbmcvc2NvcmVkL3J1bl9pZD17fS8nLCAnJHtkYXRhQnVja2V0LmJ1Y2tldE5hbWV9JywgJyQuUGF5bG9hZC5ydW5faWQnKWApXG4gICAgICAgICAgfVxuICAgICAgICBdXG4gICAgICB9XVxuICAgIH0pO1xuXG4gICAgY29uc3Qgbm90aWZ5VGFzayA9IG5ldyB0YXNrcy5MYW1iZGFJbnZva2UodGhpcywgJ05vdGlmeScsIHtcbiAgICAgIGxhbWJkYUZ1bmN0aW9uOiBub3RpZnlGbixcbiAgICAgIHBheWxvYWQ6IHNmbi5UYXNrSW5wdXQuZnJvbU9iamVjdCh7IEV4cG9ydDogc2ZuLkpzb25QYXRoLmVudGlyZVBheWxvYWQgfSksXG4gICAgICByZXN1bHRQYXRoOiBzZm4uSnNvblBhdGguRElTQ0FSRFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmaW5pdGlvbiA9IGV4cG9ydFRhc2submV4dChydW5UYXNrKS5uZXh0KG5vdGlmeVRhc2spO1xuXG4gICAgY29uc3Qgc20gPSBuZXcgc2ZuLlN0YXRlTWFjaGluZSh0aGlzLCAnVHJ1c3RTY29yaW5nU20nLCB7XG4gICAgICBkZWZpbml0aW9uQm9keTogc2ZuLkRlZmluaXRpb25Cb2R5LmZyb21DaGFpbmFibGUoZGVmaW5pdGlvbiksXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5ob3VycygyKVxuICAgIH0pO1xuXG4gICAgLy8gb3V0cHV0c1xuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ1N0YXRlTWFjaGluZUFybicsIHsgdmFsdWU6IHNtLnN0YXRlTWFjaGluZUFybiB9KTtcbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdEYXRhQnVja2V0TmFtZScsIHsgdmFsdWU6IGRhdGFCdWNrZXQuYnVja2V0TmFtZSB9KTtcbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdOb3RpZnlUb3BpY0FybicsIHsgdmFsdWU6IHRvcGljLnRvcGljQXJuIH0pO1xuICB9XG59XG4iXX0=