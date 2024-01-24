// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { updateHistoryEntry } from '../utils/historyTable';
import { CrawlContext } from '../crawler/types';
import { deleteContextTable } from '../utils/contextTable';
import { deleteQueuedPathsFromS3 } from '../utils/queuedPaths';

/**
 * This step is run at the end of our step function state machine, once all discovered urls have been visited.
 * Clear the context database.
 */
export const completeCrawl = async (
  crawlContext: CrawlContext,
) => {
  // Delete the temporary queuedPaths file from the S3 working bucket
  console.log('Deleting queuedPaths file from S3');
  await deleteQueuedPathsFromS3(crawlContext);

  // Delete the context table as we have visited all urls in the queue
  console.log('Deleting context table', crawlContext.contextTableName);
  await deleteContextTable(crawlContext.contextTableName);

  // Update the end timestamp
  console.log('Writing end timestamp to history table');
  await updateHistoryEntry(crawlContext.crawlId, {
    endTimestamp: new Date().toISOString(),
  });

  console.log('Crawl complete!');

  return {};
};
