#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { WebCrawlerStack } from '../src/stacks/web-crawler-stack';

const app = new App();

// Create the webcrawler stack
new WebCrawlerStack(app, 'WebCrawlerStack', {  });
