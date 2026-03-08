#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { PickleballStack } from '../lib/pickleball-stack'

const app = new cdk.App()

new PickleballStack(app, 'PickleballStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Pickleball G2 — auth, stats API, and storage',
})
