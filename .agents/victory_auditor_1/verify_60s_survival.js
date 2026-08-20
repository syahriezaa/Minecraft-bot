/**
 * @file verify_60s_survival.js
 * @description Script Verifikasi Independen Victory Auditor untuk 60+ Detik Live Presence & SLP.
 */

const { LiveProtocolClient } = require('../../src/network/liveProtocolClient');
const { querySLP, verifyBotOnline } = require('../../src/network/slpVerifier');
const { PersistentCompanion } = require('../../src/tasks/persistentCompanion');

async function runIndependentAudit() {
  console.log('================================================================================');
  console.log('🛡️ VICTORY AUDITOR — INDEPENDENT 60s LIVE PRESENCE & SLP VERIFICATION');
  console.log('================================================================================');

  const host = 'atoms-girl.tun.ply.gg';
  const port = 25565;
  const username = `Auditor_${Math.floor(Math.random() * 8999 + 1000)}`;

  console.log(`Target Server : ${host}:${port}`);
  console.log(`Bot Username  : ${username}`);
  console.log(`Durasi Uji    : 65 detik (Target >= 60s)\n`);

  // 1. Initial SLP Check
  console.log('1️⃣ Mengecek SLP awal sebelum bot terhubung...');
  const initialSLP = await querySLP({ host, port, timeoutMs: 10000 });
  console.log(`   - Status: Online=${initialSLP.players.online}/${initialSLP.players.max}, Latency=${initialSLP.latencyMs}ms`);

  // 2. Connect Bot
  console.log('\n2️⃣ Menghubungkan LiveProtocolClient...');
  const client = new LiveProtocolClient({
    host,
    port,
    username,
    protocolVersion: 775,
    autoReconnect: false,
    socketTimeoutMs: 30000
  });

  const companion = new PersistentCompanion(client, {
    minSurvivalDurationMs: 60000,
    keepAliveTimeoutMs: 25000,
    antiAfkIntervalMs: 1500
  });

  let kickedReason = null;
  let disconnected = false;
  let keepAlives = 0;

  client.on('keep_alive', (id) => {
    keepAlives++;
    console.log(`   💓 KeepAlive diterima (#${keepAlives}, ID: ${id})`);
  });

  client.on('kicked', (reason) => {
    kickedReason = reason;
    console.error(`   ❌ Bot Kicked: ${reason}`);
  });

  client.on('disconnect', (info) => {
    disconnected = true;
    console.warn(`   ⚠️ Bot Disconnected:`, info);
  });

  await client.connect();
  console.log(`   ✅ Bot berhasil masuk ke Play State! Entity ID: ${client.entityId}`);

  companion.start();

  // 3. SLP Check while Bot is connected
  console.log('\n3️⃣ Memverifikasi SLP saat bot terhubung...');
  await new Promise(r => setTimeout(r, 3000));
  const activeSLP = await querySLP({ host, port, timeoutMs: 10000 });
  console.log(`   - SLP Players Online: ${activeSLP.players.online}`);
  console.log(`   - SLP Players Sample: ${JSON.stringify(activeSLP.players.sample)}`);

  if (activeSLP.players.online < 1) {
    throw new Error(`SLP assertion failed: players.online (${activeSLP.players.online}) < 1`);
  }
  console.log('   ✅ SLP mengembalikan players.online >= 1 terverifikasi!');

  // 4. Survival Loop for 65 seconds
  console.log('\n4️⃣ Menjalankan pemantauan ketahanan selama 65 detik...');
  const startTime = Date.now();
  let slpCheckCount = 0;

  while (Date.now() - startTime < 65000) {
    await new Promise(r => setTimeout(r, 10000));
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    console.log(`   ⏱️ Waktu berjalan: ${elapsed}s / 65s (Status: State=${client.protocolState}, KeepAlives=${keepAlives}, Uptime=${companion.getUptimeSeconds()}s)`);

    if (client.protocolState !== 'play' || disconnected || kickedReason) {
      throw new Error(`Bot terputus sebelum 60 detik! State=${client.protocolState}, Kicked=${kickedReason}, Disconnected=${disconnected}`);
    }

    // Periodic SLP verification
    const periodicSLP = await querySLP({ host, port, timeoutMs: 5000 });
    slpCheckCount++;
    console.log(`   🔍 SLP Check #${slpCheckCount}: ${periodicSLP.players.online} online`);
    if (periodicSLP.players.online < 1) {
      console.warn(`   ⚠️ Peringatan: SLP melaporkan online=${periodicSLP.players.online}`);
    }
  }

  const finalUptime = Math.floor((Date.now() - startTime) / 1000);
  console.log(`\n🎉 Ketahanan terverifikasi: Bot bertahan selama ${finalUptime} detik (>= 60s) tanpa disconnect/kick!`);
  console.log(`   - Total KeepAlives: ${keepAlives}`);
  console.log(`   - Anti-AFK Pulses: ${companion.metrics.antiAfkPulses}`);
  console.log(`   - Packets Sent: ${companion.metrics.packetsSent}`);

  // 5. Graceful disconnect
  console.log('\n5️⃣ Memutuskan koneksi secara aman...');
  companion.stop('Audit selesai');
  client.disconnect('Audit selesai');

  console.log('================================================================================');
  console.log('✅ VICTORY AUDITOR: 60s LIVE PRESENCE & SLP AUDIT PASSED 100%');
  console.log('================================================================================');
}

runIndependentAudit().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ AUDIT FAILED:', err.message);
  process.exit(1);
});
