import { parentPort, workerData } from 'node:worker_threads';
import { createAuditSession, type AuditOptions } from './runner.js';

/**
 * One concurrency lane. Lighthouse's trace engine and logger are process-global,
 * so each lane gets its own worker thread (and its own Chrome) in order to run
 * real audits in parallel. The worker reuses one Chrome for every URL assigned
 * to it, then closes it once.
 */
interface WorkItem {
  index: number;
  url: string;
  options: AuditOptions;
}

const port = parentPort;
if (!port) throw new Error('audit-worker must run as a worker thread');

const { items } = workerData as { items: WorkItem[] };

const sendError = (item: WorkItem, error: unknown): void => {
  port.postMessage({
    type: 'error',
    index: item.index,
    message: error instanceof Error ? error.message : String(error),
  });
};

let session;
try {
  session = await createAuditSession();
} catch (error) {
  for (const item of items) sendError(item, error);
  port.postMessage({ type: 'done' });
  process.exit(0);
}

try {
  for (const item of items) {
    port.postMessage({ type: 'start', index: item.index });
    try {
      const result = await session.auditTarget(item.url, {
        ...item.options,
        onProgress: (event) => port.postMessage({ type: 'progress', index: item.index, event }),
      });
      port.postMessage({ type: 'result', index: item.index, result });
    } catch (error) {
      sendError(item, error);
    }
  }
} finally {
  await session.close();
  port.postMessage({ type: 'done' });
}
