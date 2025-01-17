// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Construct } from 'constructs';
import { CfnOutput } from 'aws-cdk-lib';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Function } from 'aws-cdk-lib/aws-lambda'
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket} from 'aws-cdk-lib/aws-s3';
import WebCrawlerLambda from './web-crawler-lambda';
import ChromeLambdaLayer from './chrome-lambda-layer';
import { DEFAULT_STATE_MACHINE_URL_THRESHOLD, DEFAULT_PARALLEL_URLS_TO_SYNC } from './constants';

export interface WebCrawlerStepLambdasProps {
  region: string;
  contextTableNamePrefix: string;
  createContextTablePolicy: (actions: string[]) => PolicyStatement;
  historyTable: Table;
  workingBucket: Bucket;
  s3DataBucket: Bucket;
  webCrawlerStateMachineArn: string;
}

export interface WebCrawlerSteps {
  startCrawl: Function;
  crawlPageAndQueueUrls: Function;
  readQueuedUrls: Function;
  completeCrawl: Function;
  continueExecution: Function;
}

/**
 * Construct which creates all the necessary lambdas for our web crawler
 */
export default class WebCrawlerStepLambdas extends Construct {
  public readonly steps: WebCrawlerSteps;

  constructor(scope: Construct, id: string, props: WebCrawlerStepLambdasProps) {
    super(scope, id);

    const { region } = props;

    // Environment variables given to the lambdas
    const environment = {
      CONTEXT_TABLE_NAME_PREFIX: props.contextTableNamePrefix,
      HISTORY_TABLE_NAME: props.historyTable.tableName,
      WORKING_BUCKET: props.workingBucket.bucketName,
      S3_DATA_BUCKET: props.s3DataBucket.bucketName,
      STATE_MACHINE_URL_THRESHOLD: String(DEFAULT_STATE_MACHINE_URL_THRESHOLD),
      PARALLEL_URLS_TO_SYNC: String(DEFAULT_PARALLEL_URLS_TO_SYNC),
    };

    // Layer including chrome for the web crawler lambdas
    const chromeLayer = new ChromeLambdaLayer(this, 'ChromeLayer');

    // Helper method to create a web crawler lambda with common properties
    const buildLambda = (id: string, handler: string) => new WebCrawlerLambda(this, id, {
      handler, environment, region, chromeLayer,
    });

    // Lambda to trigger crawling
    const startCrawl = buildLambda('StartCrawlingLambda', 'startCrawlHandler');
    props.historyTable.grantReadWriteData(startCrawl);
    startCrawl.addToRolePolicy(props.createContextTablePolicy(['CreateTable', 'DescribeTable', 'PutItem', 'GetItem']));

    // Lambda for crawling a page
    const crawlPageAndQueueUrls = buildLambda('CrawlPageAndQueueUrlsLambda', 'crawlPageAndQueueUrlsHandler');
    props.s3DataBucket.grantReadWrite(crawlPageAndQueueUrls);
    crawlPageAndQueueUrls.addToRolePolicy(props.createContextTablePolicy(['PutItem', 'GetItem', 'DeleteItem']));

    // Lambda for reading queued urls from the context table
    const readQueuedUrls = buildLambda('ReadQueuedUrlsLambda', 'readQueuedUrlsHandler');
    props.historyTable.grantReadWriteData(readQueuedUrls);
    props.workingBucket.grantReadWrite(readQueuedUrls);
    readQueuedUrls.addToRolePolicy(props.createContextTablePolicy(['Query']));
    
    // Lambda for cleaning up when crawling has finished
    const completeCrawl = buildLambda('CompleteCrawlLambda', 'completeCrawlHandler');
    props.historyTable.grantReadWriteData(completeCrawl);
    props.workingBucket.grantReadWrite(completeCrawl);
    completeCrawl.addToRolePolicy(props.createContextTablePolicy(['DeleteTable']));

    // When we've reached a certain queue size, we restart the step function execution so as not to breach the
    // execution history limit of 25000 steps
    const continueExecution = buildLambda('ContinueExecutionLambda', 'continueExecutionHandler');
    continueExecution.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [props.webCrawlerStateMachineArn],
    }));
    props.historyTable.grantReadWriteData(continueExecution);

    this.steps = {
      startCrawl,
      crawlPageAndQueueUrls,
      readQueuedUrls,
      completeCrawl,
      continueExecution,
    };

    // Save the start crawl lambda arn as a stack output for our `crawl` script
    new CfnOutput(this, 'StartCrawlFunctionArn', {
      exportName: 'StartCrawlFunctionArn',
      value: startCrawl.functionArn,
    });
  }
}
