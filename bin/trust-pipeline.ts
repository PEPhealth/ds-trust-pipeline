#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { TrustPipelineStack } from '../lib/trust-pipeline-stack';

const app = new App();

// Use the account/region from your current AWS credentials and --region flag
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION || 'us-east-2', // fallback helpful during local dev
};

new TrustPipelineStack(app, 'TrustPipelineStack', { env });
