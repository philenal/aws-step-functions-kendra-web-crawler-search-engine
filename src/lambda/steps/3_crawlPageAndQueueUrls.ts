// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import chrome from 'chrome-aws-lambda';
import { extractPageContentAndUrls } from '../crawler/core';
import { CrawlContext } from '../crawler/types';
import { markPathAsVisited, queuePaths } from '../utils/contextTable';
import { Browser } from "puppeteer-core";

/**
 * This step is the main part of the webcrawler, responsible for extracting content from a single webpage, and adding
 * any newly discovered urls to visit to the queue.
 */
export const crawlPageAndQueueUrls = async (
  path: string,
  crawlContext: CrawlContext,
) => {
  let browser: Browser | undefined;
  try {
    const { contextTableName, baseUrl, pathKeywords, crawlName } = crawlContext;

    // Mark the path as visited first so that if there are any issues visiting this page we'll move on, rather than
    // infinitely repeating the same page!
    await markPathAsVisited(contextTableName, path);
    console.log('Marked path', path, 'as visited.');

    browser = await chrome.puppeteer.launch({
      args: chrome.args,
      defaultViewport: chrome.defaultViewport,
      executablePath: await chrome.executablePath,
      headless: chrome.headless,
      ignoreHTTPSErrors: true,
    });

    const destination = { s3KeyPrefix: crawlName };
    
    // Sync the content and extract the urls to visit
    const urlPaths = await extractPageContentAndUrls(browser, {
      baseUrl,
      path,
      pathKeywords,
    }, destination );
    console.log('Synced content from', path);

    console.log('Queueing', urlPaths.length, 'new urls to visit', urlPaths);
    await queuePaths(contextTableName, urlPaths);
  } catch (e) {
    // Failure to crawl a url should not fail the entire process, we skip it and move on.
    console.error('Failed to crawl path', path, e);
  } finally {
    browser && await browser.close();
  }

  return {};
};
