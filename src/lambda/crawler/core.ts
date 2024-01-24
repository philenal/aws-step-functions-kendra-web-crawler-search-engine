// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Browser, Page } from 'puppeteer-core';
import { NodeHtmlMarkdown } from 'node-html-markdown'
import fetch from 'node-fetch';
import robotsParser from 'robots-parser';
import S3 from 'aws-sdk/clients/s3';
import { URL } from 'url';
import * as path from 'path';
import { getEnvVariableRequired } from '../utils/env';
import { CrawlDestination, CrawlPageInput, PageContent, Metadata } from './types';

const s3 = new S3();
const S3_DATA_BUCKET = getEnvVariableRequired("S3_DATA_BUCKET");

const getLastModified = async (url: string): Promise<string> => {
  try {
    // Send a HEAD request using the fetch API
    const response = await fetch(url, { method: 'HEAD' });
    if (response.ok) {
      const lastModifiedHeader = response.headers.get('Last-Modified');

      // Parse the Last-Modified date
      return lastModifiedHeader || '';
    } 
  } 
  finally {
    return ''
  }
}

const nhm = new NodeHtmlMarkdown({
  keepDataImages: true,
  ignore: ['script', 'svg', 'path']
})

/**
 * Extract content from a page and processes it to 
 * return the metadata and markdown version of the html page.
 * @param page puppeteer browser 
 * @returns PageContent
 */
const extractContent = async (page: Page): Promise<PageContent> => {
  const [ title, lastModified, url, htmlContent ] = await Promise.all([
    page.evaluate(() => document.title),
    getLastModified(page.url()),
    page.url(),
    page.evaluate(() => document.body.innerHTML),
  ]);

  const text: string = nhm.translate(htmlContent)

  const metadata: Metadata = {
    'title': title,
    'last-modified': lastModified,
    'url': url
  }
  return { 
    metadata, 
    html: text
  };
};

/**
 * Writes the given page content to S3
 */
const writePageToS3 = async (url: string, content: PageContent, destination: CrawlDestination) => {
  if (!content.html || !content.metadata) {
    console.log('Page has no content, skipping');
    return;
  }

  // We write the document to S3 under the given key prefix
  const documentKey = path.join(destination.s3KeyPrefix, `${encodeURIComponent(url)}.html`);

  await s3.putObject({ Bucket: S3_DATA_BUCKET, Key: documentKey, Body: JSON.stringify(content) }).promise();
  console.log('Written page content to s3', documentKey);
};


/**
 * Return whether the given url is within the website of the base url, ie it's a relative link, or it's an absolute
 * link that starts with the base url.
 */
const isUrlWithinBaseWebsite = (url: string, baseUrl: string): boolean => !url.startsWith('http') || url.startsWith(baseUrl);

/**
 * Return whether any of the keywords are included in the url. Keywords are optional, we include the url by default
 * if they aren't supplied.
 */
const isUrlMatchingSomeKeyword = (url: string, keywords?: string[]): boolean => (
  !keywords || keywords.length === 0 || keywords.some((keyword) => url.toLowerCase().includes(keyword))
);

/**
 * Return whether the given url is allowed in robots.txt. If there is no robots.txt, we assume all urls are allowed.
 */
const isUrlAllowedInRobots = async (urlString: string): Promise<boolean> => {
  try {
    const url = new URL(urlString)
    const robotsURL = url.origin + "/robots.txt"
    const robotsResponse = await fetch(robotsURL)
    const robotsTxt = await robotsResponse.text()
    const robots = robotsParser(robotsURL, robotsTxt)
    return robots.isAllowed(urlString) || false;
  } catch (error) {
    // There is no robots.txt, so we assume all urls are allowed
    return true;
  }
}

/**
 * Return all the urls from a page that we may enqueue for further crawling
 * @return a list of absolute urls
 */
const getLinksToFollow = async (page: Page, baseUrl: string, keywords?: string[]): Promise<string[]> => {
  // Find all the anchor tags and get the url from each
  const urls = await page.$$eval('a', ((elements: any) => elements.map((e: any) => e.getAttribute('href'))));

  // Get the base url for any relative urls
  const currentPageUrlParts = (await page.evaluate(() => document.location.href)).split('/');
  const relativeUrlBase = currentPageUrlParts.slice(0, currentPageUrlParts.length).join('/');

  // Filter to only urls within our target website, and urls that match the provided keywords
  return urls.filter((url: string | null) => url && isUrlWithinBaseWebsite(url, baseUrl)).map((url: string) => {
    if (url!.startsWith(baseUrl)) {
      return url!;
    }
    const u = new URL(url!, relativeUrlBase);
    return `${u.origin}${u.pathname}`;
  }).filter(async (url: string) => {
    return await isUrlAllowedInRobots(url) && isUrlMatchingSomeKeyword(url, keywords)
  });
};

/**
 * Uses the given browser to load the given page, writes its content to the destination, and returns any discovered urls
 * discovered from the page.
 *
 * @param browser the puppeteer browser
 * @param input the page to visit
 * @param destination (optional) the location to write content to
 * @return a list of paths (relative to the base url) that were found on the page
 */
export const extractPageContentAndUrls = async (
  browser: Browser,
  input: CrawlPageInput,
  destination: CrawlDestination,
): Promise<string[]> => {
  const url = new URL(input.path, input.baseUrl).href;
  try {
    // Visit the url and wait until network settles, a reasonable indication that js libraries etc have all loaded and
    // client-side rendering or ajax calls have completed
    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: 'networkidle0',
    });

    // Extract the content from the page
    const content = await extractContent(page);
    console.log("Extracted content from page:", content);

    // Write the content to s3 if a destination was provided
    await writePageToS3(url, content, destination);

    // Find fully qualified urls with the given base url
    const discoveredUrls = new Set(await getLinksToFollow(page, input.baseUrl, input.pathKeywords));
    console.log("Discovered urls:", discoveredUrls);

    // We return relative paths
    const discoveredPaths = [...discoveredUrls].flatMap((u) => {
      try {
        return [new URL(u).pathname];
      } catch (e) {
        console.warn('Url', u, 'was not valid and will be skipped', e);
        return [];
      }
    });
    console.log("Discovered relative paths:", discoveredPaths);

    return discoveredPaths;
  } catch (e) {
    console.warn('Could not visit url', url, e);
    return [];
  }
};
