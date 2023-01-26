#!/usr/bin/env node
import { App } from 'aws-cdk-lib/core';
import { PrivateapigwStack } from '../lib/privateapigw-stack';

const app = new App();
new PrivateapigwStack(app, 'PrivateapigwStack');
