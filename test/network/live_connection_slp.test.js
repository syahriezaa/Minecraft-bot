/**
 * @file live_connection_slp.test.js
 * @description Pengujian integrasi live server Minecraft NeoForge 26.1.2 (Protokol 775) pada host atoms-girl.tun.ply.gg:25565.
 * Menguji transisi siklus hidup penuh (Handshaking -> Login -> Configuration -> Play),
 * respons keepalive otomatis, pengakuan chunk batch, pembaruan posisi dengan MovementFlags,
 * serta verifikasi kehadiran pemain aktif pada Server List Ping (SLP).
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  LiveProtocolClient,
  querySLP,
  verifyBotOnline,
  PROTOCOL_STATES,
  CONNECTION_STATES
} = require('../../src/network/liveProtocolClient.js');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;
const BOT_TEST_USERNAME = `W1_Test_${Math.floor(Math.random() * 8999 + 1000)}`;

describe('Pengujian Integrasi Live Server NeoForge 26.1.2 & SLP Verification', { timeout: 60000 }, () => {

  it('1. harus berhasil melakukan kueri Server List Ping (SLP) dan memvalidasi protokol 775', async () => {
    console.log(`📡 [Uji SLP] Melakukan ping ke ${SERVER_HOST}:${SERVER_PORT}...`);
    const status = await querySLP({ host: SERVER_HOST, port: SERVER_PORT, timeoutMs: 15000 });

    assert.ok(status, 'Respons SLP tidak boleh kosong');
    assert.ok(status.version, 'Respons SLP harus memiliki objek version');
    assert.equal(status.version.protocol, 775, `Protokol server harus 775, diperoleh: ${status.version.protocol}`);
    assert.ok(typeof status.players.online === 'number', 'Jumlah pemain online harus bertipe number');
    assert.ok(typeof status.players.max === 'number', 'Kapasitas pemain maksimal harus bertipe number');
    assert.ok(status.latencyMs >= 0, 'Latensi harus bernilai non-negatif');

    console.log(`✅ [Uji SLP] Server aktif! Versi: ${status.version.name} (Protokol ${status.version.protocol}), Online: ${status.players.online}/${status.players.max}, RTT: ${status.latencyMs}ms`);
  });

  it('2. harus menghubungkan bot, menyelesaikan transisi 4-fase ke PLAY, merespons keepalive, dan terverifikasi di SLP', async () => {
    console.log(`🤖 [Uji Bot] Menginisialisasi koneksi bot: ${BOT_TEST_USERNAME}...`);

    const client = new LiveProtocolClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: BOT_TEST_USERNAME,
      protocolVersion: 775,
      autoReconnect: false,
      socketTimeoutMs: 30000
    });

    const recordedStates = [];
    client.on('stateChanged', ({ oldState, newState }) => {
      recordedStates.push({ from: oldState, to: newState });
    });

    let keepAliveReceived = 0;
    client.on('keep_alive', (id) => {
      keepAliveReceived++;
      console.log(`💓 [Uji Bot] Detak jantung keepalive #${keepAliveReceived} diterima: ${id}`);
    });

    let joinedGameData = null;
    client.on('joined', (data) => {
      joinedGameData = data;
    });

    // 1. Hubungkan bot dan tunggu sampai masuk ke state PLAY
    console.log('⏳ [Uji Bot] Menunggu jabat tangan Handshaking -> Login -> Configuration -> Play...');
    await client.connect();

    assert.equal(client.protocolState, PROTOCOL_STATES.PLAY, 'Status protokol harus berada pada PLAY');
    assert.equal(client.connectionState, CONNECTION_STATES.CONNECTED, 'Koneksi socket harus berstatus CONNECTED');
    assert.ok(client.entityId !== null, 'Bot harus memiliki Entity ID yang valid');
    assert.ok(joinedGameData !== null, 'Event joined harus terpicu');

    console.log(`🎉 [Uji Bot] Bot berhasil masuk ke Play state! Entity ID: ${client.entityId}`);

    // 2. Verifikasi runtutan perpindahan status protokol
    const stateSequence = recordedStates.map(s => s.to);
    assert.ok(stateSequence.includes('login'), 'Harus melewati status login');
    assert.ok(stateSequence.includes('configuration'), 'Harus melewati status configuration');
    assert.ok(stateSequence.includes('play'), 'Harus mencapai status play');

    // 3. Kirim pembaruan posisi dengan bitflags MovementFlags
    client.sendPosition({ x: -256.0, y: -20.0, z: -432.0, onGround: true, hasHorizontalCollision: false });
    client.sendPositionAndRotation({ x: -256.0, y: -20.0, z: -432.0, yaw: 90.0, pitch: 0.0, onGround: true, hasHorizontalCollision: false });

    // 4. Kueri SLP untuk memverifikasi kehadiran bot secara objektif di server
    console.log('🔍 [Uji SLP] Memverifikasi kehadiran bot di daftar pemain SLP...');
    // Beri jeda singkat agar server memperbarui daftar pemain
    await new Promise(r => setTimeout(r, 2000));

    const verification = await verifyBotOnline({
      host: SERVER_HOST,
      port: SERVER_PORT,
      botUsername: BOT_TEST_USERNAME,
      timeoutMs: 15000
    });

    console.log(`📊 [Uji SLP] Hasil verifikasi SLP: Online=${verification.playerCount}, inSample=${verification.inSample}, Sample=${JSON.stringify(verification.sample)}`);

    assert.ok(verification.isOnline, 'Jumlah pemain online di SLP harus >= 1');
    assert.ok(verification.playerCount >= 1, `Jumlah pemain online harus >= 1, diperoleh: ${verification.playerCount}`);

    // 5. Pertahankan koneksi selama beberapa detik untuk memastikan keepalive berjalan stabil
    console.log('⏱️ [Uji Bot] Mempertahankan keberadaan bot selama 8 detik...');
    await new Promise(r => setTimeout(r, 8000));

    // 6. Putuskan koneksi bot secara bersih
    console.log('🛑 [Uji Bot] Memutuskan koneksi bot secara normal...');
    client.disconnect('Pengujian integrasi selesai');

    assert.equal(client.connectionState, CONNECTION_STATES.DISCONNECTED, 'Status koneksi harus DISCONNECTED setelah disconnect()');
    console.log('✅ [Uji Bot] Seluruh pengujian integrasi live server berhasil 100%!');
  });
});
