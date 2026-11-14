import { startFixture } from '../test/flows/fixture.js';

// Serves the deterministic flow fixture for scripts/size-report.mjs. The URL is
// printed as the first stdout line so the parent can start auditing.
const site = await startFixture();
console.log(site.url);

const stop = async (): Promise<void> => {
  await site.close();
  process.exit(0);
};

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
