/**
 * probe_detailed.js
 * Comprehensive probe of Minecraft 1.21.1 / NeoForge 26.1.2 protocol channels and packets.
 */
const mc = require('minecraft-protocol');

const HOST = 'atoms-girl.tun.ply.gg';
const PORT = 25565;
const USERNAME = 'ProbeBot_NF26';

console.log(`[PROBE] Starting detailed probe against ${HOST}:${PORT}...`);

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

const receivedPackets = [];
const customPayloads = [];
const configPackets = [];
const playPackets = [];

client.on('state', (newState, oldState) => {
  console.log(`[STATE TRANSITION] ${oldState} -> ${newState}`);
});

client.on('packet', (data, meta) => {
  const summary = {
    state: client.state,
    name: meta.name,
    timestamp: new Date().toISOString()
  };
  receivedPackets.push(summary);

  if (client.state === 'configuration') {
    configPackets.push(meta.name);
    console.log(`[CONFIG] Received packet: ${meta.name}`);
    if (meta.name === 'registry_data') {
      console.log(`  -> Registry: ${data.registryId}`);
    } else if (meta.name === 'custom_payload') {
      console.log(`  -> Custom Payload Channel: ${data.channel}`);
      customPayloads.push({ state: 'configuration', channel: data.channel, data: data.data });
    } else if (meta.name === 'select_known_packs') {
      console.log(`  -> Select Known Packs:`, data.knownPacks);
    } else if (meta.name === 'feature_flags') {
      console.log(`  -> Feature flags:`, data.features);
    }
  } else if (client.state === 'play') {
    playPackets.push(meta.name);
    if (meta.name === 'custom_payload') {
      console.log(`[PLAY CUSTOM PAYLOAD] Channel: ${data.channel}`);
      customPayloads.push({ state: 'play', channel: data.channel, data: data.data });
    }
  }
});

client.on('custom_payload', (packet) => {
  console.log(`[EVENT: custom_payload] State: ${client.state}, Channel: ${packet.channel}, Length: ${packet.data ? packet.data.length : 0}`);
});

client.on('login', (packet) => {
  console.log(`[EVENT: login] Successfully reached Play state! Entity ID: ${packet.entityId}, Dimension: ${packet.dimension}`);
});

client.on('spawn', () => {
  console.log(`[EVENT: spawn] Bot spawned in world!`);
});

client.on('keep_alive', (packet) => {
  console.log(`[EVENT: keep_alive] ID: ${packet.keepAliveId}`);
  try {
    client.write('keep_alive', { keepAliveId: packet.keepAliveId });
    console.log(`  -> Acknowledged keep_alive.`);
  } catch (e) {
    console.error('  -> Failed to reply keep_alive:', e.message);
  }
});

client.on('position', (packet) => {
  console.log(`[EVENT: position] x=${packet.x.toFixed(2)}, y=${packet.y.toFixed(2)}, z=${packet.z.toFixed(2)}, teleportId=${packet.teleportId}`);
  if (packet.teleportId !== undefined) {
    try {
      client.write('teleport_confirm', { teleportId: packet.teleportId });
      console.log(`  -> Sent teleport_confirm (${packet.teleportId})`);
    } catch (e) {
      console.error('  -> Failed teleport_confirm:', e.message);
    }
  }
});

client.on('error', (err) => {
  console.error('[CLIENT ERROR]:', err);
});

client.on('end', (reason) => {
  console.log(`[CLIENT END]: ${reason}`);
  printSummary();
  process.exit(0);
});

function printSummary() {
  console.log('\n=== PROBE SUMMARY ===');
  console.log(`Total Packets Received: ${receivedPackets.length}`);
  console.log(`Configuration Packets (${configPackets.length}):`, [...new Set(configPackets)]);
  console.log(`Custom Payloads (${customPayloads.length}):`, customPayloads.map(cp => `[${cp.state}] ${cp.channel}`));
  console.log(`Play Packets Sample:`, [...new Set(playPackets)].slice(0, 15));
}

// Run for 12 seconds then disconnect cleanly
setTimeout(() => {
  console.log('\n[PROBE] Probe time elapsed (12s). Disconnecting...');
  printSummary();
  client.end('Probe complete');
  setTimeout(() => process.exit(0), 1000);
}, 12000);
