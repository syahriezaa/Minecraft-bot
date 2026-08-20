/**
 * probe_raw.js
 * Inspect exact packet stream and identify where 'toString' error occurs.
 */
const net = require('net');
const mc = require('minecraft-protocol');

const HOST = 'atoms-girl.tun.ply.gg';
const PORT = 25565;
const USERNAME = 'ProbeBot_Stack';

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

client.on('error', (err) => {
  console.error('[CLIENT ERROR FULL STACK]:\n', err.stack);
});

client.on('raw', (buffer, meta) => {
  console.log(`[RAW PACKET] state: ${client.state}, name: ${meta.name}, id: 0x${meta.id.toString(16)}, size: ${buffer.length}`);
});

client.on('state', (newState, oldState) => {
  console.log(`[STATE] ${oldState} -> ${newState}`);
});

client.on('custom_payload', (packet) => {
  console.log(`[CUSTOM_PAYLOAD] channel: ${packet.channel}, payload:`, packet.data || packet.payload);
});

client.on('end', (reason) => {
  console.log(`[END] ${reason}`);
  process.exit(0);
});

setTimeout(() => {
  console.log('Timeout reached');
  process.exit(0);
}, 10000);
