/**
 * probe_neoforge.js
 * Probe live packet stream and custom payloads on atoms-girl.tun.ply.gg:25565
 */
const mc = require('minecraft-protocol');

const HOST = 'atoms-girl.tun.ply.gg';
const PORT = 25565;
const USERNAME = 'ProbeBot_NF26';

console.log(`[PROBE] Querying SLP on ${HOST}:${PORT}...`);
mc.ping({ host: HOST, port: PORT }, (err, result) => {
  if (err) {
    console.error('[PROBE] SLP Error:', err.message);
  } else {
    console.log('[PROBE] SLP Result:', JSON.stringify(result, null, 2));
  }

  console.log(`\n[PROBE] Connecting client to ${HOST}:${PORT} (version: 26.1.2, protocol 775)...`);
  
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

  const packetLog = [];

  client.on('state', (newState, oldState) => {
    console.log(`[STATE CHANGE] ${oldState} -> ${newState}`);
    packetLog.push({ type: 'state', from: oldState, to: newState, time: Date.now() });
  });

  client.on('packet', (data, packetMeta, buffer, fullBuffer) => {
    const packetInfo = {
      state: client.state,
      name: packetMeta.name,
      id: packetMeta.id,
      size: buffer ? buffer.length : 0
    };
    
    // Detailed inspection for custom payloads or configuration packets
    if (packetMeta.name === 'custom_payload' || packetMeta.name === 'custom_payload_to_server') {
      console.log(`[CUSTOM PAYLOAD] State: ${client.state}, Channel: ${data.channel}, Data Length: ${data.data ? data.data.length : (data.payload ? data.payload.length : 'N/A')}`);
      if (data.channel) {
        console.log(`[CUSTOM PAYLOAD DETAIL] Channel: ${data.channel}, Raw buffer:`, data.data || data.payload);
      }
      packetLog.push({ type: 'custom_payload', state: client.state, channel: data.channel, data: (data.data || data.payload) });
    } else if (client.state === 'configuration') {
      console.log(`[CONFIG PACKET] ${packetMeta.name} (id: 0x${packetMeta.id.toString(16)})`);
      packetLog.push({ type: 'config_packet', name: packetMeta.name, id: packetMeta.id });
    } else if (packetMeta.name === 'login' || packetMeta.name === 'success' || packetMeta.name === 'finish_configuration') {
      console.log(`[LIFECYCLE PACKET] State: ${client.state}, Name: ${packetMeta.name}`);
      packetLog.push({ type: 'lifecycle', state: client.state, name: packetMeta.name });
    } else if (packetMeta.name === 'disconnect' || packetMeta.name === 'kick_disconnect') {
      console.log(`[DISCONNECT] Reason:`, JSON.stringify(data.reason));
      packetLog.push({ type: 'disconnect', reason: data.reason });
    }
  });

  client.on('custom_payload', (packet) => {
    console.log(`[EVENT: custom_payload] Channel: ${packet.channel}`);
  });

  client.on('login', (packet) => {
    console.log(`[PLAY LOGIN] Successfully reached Play state! Entity ID: ${packet.entityId}, Dimension: ${packet.dimension}`);
  });

  client.on('keep_alive', (packet) => {
    console.log(`[KEEP ALIVE] Received keepAliveId: ${packet.keepAliveId}`);
    try {
      client.write('keep_alive', { keepAliveId: packet.keepAliveId });
      console.log(`[KEEP ALIVE] Responded keepAliveId: ${packet.keepAliveId}`);
    } catch (e) {
      console.error(`[KEEP ALIVE ERROR]`, e.message);
    }
  });

  client.on('error', (err) => {
    console.error('[CLIENT ERROR]:', err.message);
  });

  client.on('end', (reason) => {
    console.log('[CLIENT END]:', reason);
    setTimeout(() => process.exit(0), 1000);
  });

  // Keep alive for 15 seconds then disconnect cleanly
  setTimeout(() => {
    console.log('[PROBE] Probe finished 15s sample, disconnecting...');
    client.end('Probe completed');
    setTimeout(() => process.exit(0), 1000);
  }, 15000);
});
