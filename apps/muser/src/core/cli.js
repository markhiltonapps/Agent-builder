'use strict';
// Headless entry: runs the Muser server on its own so the UI can be opened in any browser,
// and so tests can start, kill and restart it.

const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./server');

async function main() {
  const dataDir = process.env.MUSER_DATA_DIR || path.join(os.homedir(), '.muser');
  const app = createApp({ dataDir });
  const { url } = await app.listen(Number(process.env.MUSER_PORT || 0));
  console.log(`MUSER_READY ${url}`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
