'use strict';
// Headless entry: runs the Muser server on its own so the UI can be opened in any browser,
// and so tests can start, kill and restart it.
//   node src/core/cli.js          this computer only (127.0.0.1)
//   node src/core/cli.js --lan    also reachable from phones/tablets on your network, behind a secret key

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('./server');

// Wi-Fi/Ethernet addresses first: 192.168.x.x, then 10.x.x.x, then 172.16-31.x.x.
function lanAddresses() {
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    .sort((a, b) => rank(a) - rank(b));
}

async function main() {
  const lan = process.env.MUSER_LAN === '1' || process.argv.includes('--lan');
  const dataDir = process.env.MUSER_DATA_DIR || path.join(os.homedir(), '.muser');
  const lanKey = lan ? crypto.randomBytes(16).toString('hex') : undefined;
  const app = createApp({ dataDir, lanKey });
  const wanted = Number(process.env.MUSER_PORT || (lan ? 4777 : 0));
  let started;
  try {
    started = await app.listen(wanted);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${wanted} is already in use. Close the other Muser, or pick another: MUSER_PORT=4888 npm run serve:lan`);
      process.exit(1);
    }
    throw err;
  }
  const { port } = started;
  // The first line is machine-readable (tests wait for it).
  console.log(`MUSER_READY ${lan ? `http://127.0.0.1:${port}/?key=${lanKey}` : started.url}`);

  if (lan) {
    const addrs = lanAddresses();
    console.log('\nMuser is open to your network. Anyone with the link below can use it, so keep it private.\n');
    if (!addrs.length) console.log('No network address found. Are you connected to Wi-Fi?\n');
    for (const ip of addrs) console.log(`  On your phone, open:  http://${ip}:${port}/?key=${lanKey}`);
    if (addrs.length) {
      try {
        // Optional: a QR code so you do not have to type the key.
        require('qrcode-terminal').generate(`http://${addrs[0]}:${port}/?key=${lanKey}`, { small: true }, (qr) => console.log(`\n${qr}`));
      } catch { /* qrcode-terminal not installed: the link above still works */ }
    }
    console.log('\nPhone and computer must be on the same Wi-Fi. Press Ctrl+C here to stop sharing.');
  }

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
