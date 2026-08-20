/**
 * probe_channels.js
 * Test sending custom payload channel registrations (minecraft:register) and custom brand,
 * and test sending neoforge channel inquiries to see how atoms-girl.tun.ply.gg responds.
 */
const mc = require('minecraft-protocol');

const HOST = 'atoms-girl.tun.ply.gg';
const PORT = 25565;
const USERNAME = 'ProbeBot_Chan';

console.log(`[PROBE CHANNELS] Connecting to ${HOST}:${PORT}...`);

const client = mc.createClient({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: 'offline',
  version: '26.1.2',
  protocolVersion: 775,
  skipValidation: true,
  hideErrors: false
});

client.on('state', (newState, oldState) => {
  console.log(`[STATE] ${oldState} -> ${newState}`);
  if (newState === 'configuration') {
    // Send minecraft:brand
    try {
      const brandBuf = Buffer.from('\x08neoforge'); // length prefixed string or raw
      client.write('custom_payload', {
        channel: 'minecraft:brand',
        data: Buffer.from([8, ...Buffer.from('neoforge', 'utf8')])
      });
      console.log('  -> Sent custom_payload (minecraft:brand -> neoforge)');
    } catch (e) {
      console.error('  -> Failed to send brand:', e.message);
    }

    // Send channel registration
    try {
      const registeredChannels = ['minecraft:register', 'neoforge:network', 'fml:handshake'].join('\0');
      client.write('custom_payload', {
        channel: 'minecraft:register',
        data: Buffer.from(registeredChannels, 'utf8')
      });
      console.log('  -> Sent minecraft:register with channels:', registeredChannels);
    } catch (e) {
      console.error('  -> Failed to send register channel:', e.message);
    }
  }
});

client.on('custom_payload', (packet) => {
  console.log(`[CUSTOM_PAYLOAD RECV] State: ${client.state}, Channel: ${packet.channel}, Length: ${packet.data ? packet.data.length : 0}`);
  if (packet.data) {
    console.log(`  Raw payload:`, packet.data);
    console.log(`  UTF-8 String:`, packet.data.toString('utf8').replace(/[^\x20-\x7E]/g, '.'));
  }
});

client.on('login', (packet) => {
  console.log(`[LOGIN RECV] Game joined! Entity ID: ${packet.entityId}`);
});

client.on('position', (packet) => {
  if (packet.teleportId !== undefined) {
    client.write('teleport_confirm', { teleportId: packet.teleportId });
  }
});

client.on('keep_alive', (packet) => {
  client.write('keep_alive', { keepAliveId: packet.keepAliveId });
});

client.on('error', (err) => {
  console.error('[ERROR]', err.message);
});

client.on('end', (reason) => {
  console.log('[END]', reason);
});

setTimeout(() => {
  console.log('[PROBE CHANNELS] 10s finished, disconnecting.');
  client.end('Done');
  process.exit(0);
}, 10000);
