#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import { PrivateapigwStack } from '../lib/privateapigw-stack';

const app = new cdk.App();
new PrivateapigwStack(app, 'PrivateapigwStack');
