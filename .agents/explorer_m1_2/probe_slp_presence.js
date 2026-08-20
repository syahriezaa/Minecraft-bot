/**
 * probe_slp_presence.js
 * Test SLP query before, during, and after bot connection to verify players.online & players.sample.
 */
const mc = require('minecraft-protocol');

const HOST = 'atoms-girl.tun.ply.gg';
const PORT = 25565;
const BOT_NAME = 'NeoVerifierLive';

function querySLP(label) {
  return new Promise((resolve) => {
    mc.ping({ host: HOST, port: PORT }, (err, res) => {
      if (err) {
        console.error(`[SLP - ${label}] Error:`, err.message);
        resolve(null);
      } else {
        console.log(`[SLP - ${label}] Online: ${res.players.online}/${res.players.max}, Sample:`, JSON.stringify(res.players.sample));
        resolve(res);
      }
    });
  });
}

async function run() {
  console.log('=== STEP 1: Query SLP before connect ===');
  await querySLP('BEFORE');

  console.log('\n=== STEP 2: Connect Bot ===');
  const client = mc.createClient({
    host: HOST,
    port: PORT,
    username: BOT_NAME,
    auth: 'offline',
    version: '26.1.2',
    protocolVersion: 775,
    skipValidation: true
  });

  client.on('login', async (packet) => {
    console.log(`[BOT] Logged in successfully! Entity ID: ${packet.entityId}`);
    
    // Query SLP while bot is online
    setTimeout(async () => {
      console.log('\n=== STEP 3: Query SLP while bot is online ===');
      const res = await querySLP('DURING');
      
      const foundInSample = res && res.players.sample && res.players.sample.some(p => p.name === BOT_NAME);
      console.log(`[VERIFY] Bot '${BOT_NAME}' in players.sample: ${foundInSample}`);
      console.log(`[VERIFY] players.online >= 1: ${res && res.players.online >= 1}`);

      setTimeout(() => {
        console.log('\n=== STEP 4: Disconnect Bot ===');
        client.end('Test finished');
      }, 3000);
    }, 2000);
  });

  client.on('position', (packet) => {
    if (packet.teleportId !== undefined) {
      client.write('teleport_confirm', { teleportId: packet.teleportId });
    }
  });

  client.on('keep_alive', (packet) => {
    client.write('keep_alive', { keepAliveId: packet.keepAliveId });
  });

  client.on('end', async () => {
    console.log('[BOT] Disconnected.');
    setTimeout(async () => {
      console.log('\n=== STEP 5: Query SLP after disconnect ===');
      await querySLP('AFTER');
      process.exit(0);
    }, 2000);
  });

  client.on('error', (err) => {
    console.error('[BOT ERROR]', err.message);
  });
}

run();
