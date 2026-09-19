const net = require('net');
const mc = require('minecraft-protocol');

console.log('--- 1. TESTING TCP CONNECTION TO atoms-girl.tun.ply.gg:25565 ---');
const socket = net.createConnection({ host: 'atoms-girl.tun.ply.gg', port: 25565, timeout: 5000 });

socket.on('connect', () => {
  console.log('✅ TCP Socket connected successfully!');
  socket.end();
});

socket.on('error', (err) => {
  console.error('❌ TCP Socket Error:', err.message);
});

socket.on('timeout', () => {
  console.error('❌ TCP Socket Timeout!');
  socket.destroy();
});

setTimeout(() => {
  console.log('\n--- 2. TESTING MINECRAFT SLP PING ---');
  mc.ping({ host: 'atoms-girl.tun.ply.gg', port: 25565, timeout: 5000 }, (err, res) => {
    if (err) {
      console.error('❌ SLP Ping Error:', err.message);
    } else {
      console.log('✅ SLP Ping Success!');
      console.log('Version:', res.version);
      console.log('Players:', res.players);
    }
    process.exit(0);
  });
}, 1000);
