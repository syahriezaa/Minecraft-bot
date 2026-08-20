/**
 * @file slp_verifier.test.js
 * @description Suite Pengujian Komprehensif SLP Verifier Engine & CLI Utility dengan Mock SLP Server.
 * Menguji codec VarInt/String, PacketFramer, kueri SLP standar, verifikasi bot,
 * ping/pong RTT, penanganan kegagalan jaringan, fragmentasi TCP, dan eksekusi CLI.
 *
 * Aturan Tim: Semua komentar kode, error message, dan teks UI ditulis dalam Bahasa Indonesia.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  querySLP,
  verifyBotOnline,
  PacketFramer,
  writeVarInt,
  readVarInt,
  writeString,
  readString,
  extractPlainText
} = require('../../src/network/slpVerifier.js');

const { MockSlpServer, MOCK_BEHAVIORS } = require('../helpers/mockSlpServer.js');

describe('Suite Pengujian SLP Verifier Engine & Jaringan Minecraft', () => {
  let mockServer;
  let mockPort;

  before(async () => {
    mockServer = new MockSlpServer();
    mockPort = await mockServer.start(0);
  });

  after(async () => {
    if (mockServer) {
      await mockServer.stop();
    }
  });

  beforeEach(() => {
    mockServer.setBehavior(MOCK_BEHAVIORS.NORMAL);
    mockServer.clearHistory();
    mockServer.setStatus({
      version: { name: 'NeoForge 26.1.2', protocol: 775 },
      players: {
        online: 1,
        max: 20,
        sample: [{ name: 'Bot_AI_Companion', id: 'e9a03c3b-58bb-3746-81c8-dbfa74b1e5a1' }]
      },
      description: { text: 'Server Minecraft Uji Deterministik' },
      favicon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    });
  });

  describe('1. Pengujian Codec Biner Rendah (VarInt, String, PacketFramer, & PlainText)', () => {
    it('harus menulis dan membaca VarInt dengan benar pada berbagai nilai bilangan', () => {
      const testValues = [0, 1, 127, 128, 255, 775, 25565, 65535, 2147483647];
      for (const val of testValues) {
        const encoded = writeVarInt(val);
        const decoded = readVarInt(encoded, 0);
        assert.ok(decoded, `Gagal membaca VarInt untuk nilai ${val}`);
        assert.equal(decoded.value, val, `Nilai decode VarInt (${decoded.value}) tidak cocok dengan nilai asli (${val})`);
        assert.equal(decoded.size, encoded.length, `Panjang byte VarInt tidak sesuai`);
      }
    });

    it('harus mengembalikan null saat membaca VarInt dari buffer yang terpotong (fragmented)', () => {
      // Byte 0x80 menunjukkan ada byte lanjutan, namun buffer diakhiri sebelum byte penutup
      const truncatedBuf = Buffer.from([0x80]);
      const res = readVarInt(truncatedBuf, 0);
      assert.equal(res, null, 'Harus mengembalikan null saat VarInt belum lengkap');
    });

    it('harus menulis dan membaca string UTF-8 diawali VarInt panjang', () => {
      const testStrings = [
        '',
        'atoms-girl.tun.ply.gg',
        'Bot_AI_Companion',
        'Server Indonesia Merdeka! 🇮🇩 🎮'
      ];
      for (const str of testStrings) {
        const encoded = writeString(str);
        const decoded = readString(encoded, 0);
        assert.ok(decoded, `Gagal membaca string untuk '${str}'`);
        assert.equal(decoded.value, str, `String decode '${decoded.value}' tidak cocok dengan '${str}'`);
        assert.equal(decoded.size, encoded.length, `Panjang byte string tidak sesuai`);
      }
    });

    it('harus mengembalikan null saat membaca string dari buffer yang belum lengkap', () => {
      const fullStrBuf = writeString('Halo Dunia');
      const truncated = fullStrBuf.subarray(0, fullStrBuf.length - 3);
      const res = readString(truncated, 0);
      assert.equal(res, null, 'Harus mengembalikan null jika panjang string belum memenuhi VarInt len');
    });

    it('harus mengekstrak teks polos dari objek Chat Component maupun string sederhana', () => {
      assert.equal(extractPlainText('Teks Sederhana'), 'Teks Sederhana');
      assert.equal(extractPlainText({ text: 'Halo ' }), 'Halo ');
      assert.equal(
        extractPlainText({
          text: 'Selamat ',
          extra: [{ text: 'Datang ' }, { text: 'di Dunia!', extra: [{ text: ' 🔥' }] }]
        }),
        'Selamat Datang di Dunia! 🔥'
      );
      assert.equal(extractPlainText(null), '');
      assert.equal(extractPlainText(undefined), '');
    });

    it('PacketFramer harus mengakumulasi chunk dan mengekstrak frame paket secara presisi', () => {
      const framer = new PacketFramer();
      assert.equal(framer.length, 0);

      // Buat 2 frame paket tiruan
      const payload1 = Buffer.from([0x00, 0x01, 0x02]);
      const frame1 = Buffer.concat([writeVarInt(payload1.length), payload1]);

      const payload2 = Buffer.from([0x01, 0xAA, 0xBB, 0xCC]);
      const frame2 = Buffer.concat([writeVarInt(payload2.length), payload2]);

      const combined = Buffer.concat([frame1, frame2]);

      // Kirim sebagian byte pertama
      framer.append(combined.subarray(0, 2));
      assert.equal(framer.readNextFrame(), null, 'Frame belum lengkap seharusnya mengembalikan null');

      // Kirim sisa frame 1 dan sebagian frame 2
      framer.append(combined.subarray(2, frame1.length + 1));
      const extracted1 = framer.readNextFrame();
      assert.ok(extracted1);
      assert.deepEqual(extracted1, payload1);

      // Kirim sisa frame 2
      framer.append(combined.subarray(frame1.length + 1));
      const extracted2 = framer.readNextFrame();
      assert.ok(extracted2);
      assert.deepEqual(extracted2, payload2);

      // Pastikan buffer kosong
      assert.equal(framer.readNextFrame(), null);
      assert.equal(framer.length, 0);
    });
  });

  describe('2. Kueri SLP Standar (Happy Path & Ping/Pong RTT)', () => {
    it('harus berhasil mengembalikan objek status lengkap dan latensi non-negatif', async () => {
      const res = await querySLP({ host: '127.0.0.1', port: mockPort, timeoutMs: 3000 });
      assert.ok(res);
      assert.equal(res.version.name, 'NeoForge 26.1.2');
      assert.equal(res.version.protocol, 775);
      assert.equal(res.players.online, 1);
      assert.equal(res.players.max, 20);
      assert.equal(res.players.sample.length, 1);
      assert.equal(res.players.sample[0].name, 'Bot_AI_Companion');
      assert.equal(res.descriptionText, 'Server Minecraft Uji Deterministik');
      assert.ok(typeof res.latencyMs === 'number' && res.latencyMs >= 0);
      assert.ok(res.favicon && res.favicon.startsWith('data:image/png;base64,'));
    });

    it('harus mengirimkan parameter Handshake (Protocol 775, NextState 1) yang diverifikasi oleh mock server', async () => {
      await querySLP({ host: '127.0.0.1', port: mockPort, protocolVersion: 775 });
      const history = mockServer.getQueryHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].protocolVersion, 775);
      assert.equal(history[0].nextState, 1);
    });

    it('harus menangani fallback latensi secara anggun jika server menutup soket setelah Status Response (DROP_AFTER_STATUS)', async () => {
      mockServer.setBehavior(MOCK_BEHAVIORS.DROP_AFTER_STATUS);
      const res = await querySLP({ host: '127.0.0.1', port: mockPort, timeoutMs: 3000 });
      assert.ok(res);
      assert.equal(res.players.online, 1);
      assert.ok(res.latencyMs >= 0);
    });
  });

  describe('3. Verifikasi Keberadaan Bot (verifyBotOnline)', () => {
    it('harus mengembalikan isOnline=true dan inSample=true saat bot ada di sample list', async () => {
      const res = await verifyBotOnline({
        host: '127.0.0.1',
        port: mockPort,
        botUsername: 'Bot_AI_Companion'
      });
      assert.equal(res.isOnline, true);
      assert.equal(res.playerCount, 1);
      assert.equal(res.maxPlayers, 20);
      assert.equal(res.inSample, true);
      assert.equal(res.sampleOmitted, false);
    });

    it('harus mencocokkan nama bot secara case-insensitive', async () => {
      const res = await verifyBotOnline({
        host: '127.0.0.1',
        port: mockPort,
        botUsername: 'bot_ai_companion'
      });
      assert.equal(res.isOnline, true);
      assert.equal(res.inSample, true);
    });

    it('harus mengembalikan isOnline=false dan inSample=false jika pemain online >= 1 namun nama bot tidak ada di sample', async () => {
      const res = await verifyBotOnline({
        host: '127.0.0.1',
        port: mockPort,
        botUsername: 'PemainLainYangTidakAda'
      });
      assert.equal(res.isOnline, false);
      assert.equal(res.playerCount, 1);
      assert.equal(res.inSample, false);
      assert.equal(res.sampleOmitted, false);
    });

    it('harus mengembalikan isOnline=false saat server kosong (players.online = 0)', async () => {
      mockServer.setPlayers(0, 20, []);
      const res = await verifyBotOnline({
        host: '127.0.0.1',
        port: mockPort,
        botUsername: 'Bot_AI_Companion'
      });
      assert.equal(res.isOnline, false);
      assert.equal(res.playerCount, 0);
      assert.equal(res.inSample, false);
    });

    it('harus menangani respon server di mana players.sample ditiadakan (omitted/null)', async () => {
      mockServer.setStatus({ players: { online: 3, max: 20 } });
      const res = await verifyBotOnline({
        host: '127.0.0.1',
        port: mockPort,
        botUsername: 'Bot_AI_Companion'
      });
      assert.equal(res.isOnline, true);
      assert.equal(res.playerCount, 3);
      assert.equal(res.inSample, false);
      assert.equal(res.sampleOmitted, true);
    });

    it('harus memvalidasi keberadaan pemain umum jika botUsername tidak disertakan', async () => {
      const res = await verifyBotOnline({
        host: '127.0.0.1',
        port: mockPort
      });
      assert.equal(res.isOnline, true);
      assert.equal(res.playerCount, 1);
      assert.equal(res.inSample, false);
    });
  });

  describe('4. Injeksi Kegagalan Jaringan & Robustness', () => {
    it('harus melempar error timeout jika server menggantung (HANG)', async () => {
      mockServer.setBehavior(MOCK_BEHAVIORS.HANG);
      await assert.rejects(
        async () => {
          await querySLP({ host: '127.0.0.1', port: mockPort, timeoutMs: 300 });
        },
        /Batas waktu.*habis/i
      );
    });

    it('harus melempar error jika koneksi ditolak (ECONNREFUSED) pada port tidak aktif', async () => {
      const unusedPort = 59123;
      await assert.rejects(
        async () => {
          await querySLP({ host: '127.0.0.1', port: unusedPort, timeoutMs: 500 });
        },
        /(ECONNREFUSED|Kesalahan koneksi)/i
      );
    });

    it('harus melempar error deskriptif jika JSON status rusak (MALFORMED_JSON)', async () => {
      mockServer.setBehavior(MOCK_BEHAVIORS.MALFORMED_JSON);
      await assert.rejects(
        async () => {
          await querySLP({ host: '127.0.0.1', port: mockPort, timeoutMs: 1000 });
        },
        /Gagal mem-parsing respons JSON/i
      );
    });

    it('harus menangani fragmentasi paket TCP byte-by-byte (TCP_FRAGMENTED) secara sempurna', async () => {
      mockServer.setBehavior(MOCK_BEHAVIORS.TCP_FRAGMENTED);
      const res = await querySLP({ host: '127.0.0.1', port: mockPort, timeoutMs: 4000 });
      assert.ok(res);
      assert.equal(res.players.online, 1);
      assert.equal(res.version.name, 'NeoForge 26.1.2');
    });

    it('harus menangani pemutusan koneksi saat handshake (DROP_ON_HANDSHAKE)', async () => {
      mockServer.setBehavior(MOCK_BEHAVIORS.DROP_ON_HANDSHAKE);
      await assert.rejects(
        async () => {
          await querySLP({ host: '127.0.0.1', port: mockPort, timeoutMs: 1000 });
        },
        /Koneksi terputus/i
      );
    });

    it('harus menangani pemutusan koneksi saat status request (DROP_ON_STATUS_REQUEST)', async () => {
      mockServer.setBehavior(MOCK_BEHAVIORS.DROP_ON_STATUS_REQUEST);
      await assert.rejects(
        async () => {
          await querySLP({ host: '127.0.0.1', port: mockPort, timeoutMs: 1000 });
        },
        /Koneksi terputus/i
      );
    });
  });

  describe('5. Uji Eksekusi CLI test/verify_slp.js', () => {
    const cliScriptPath = path.join(__dirname, '..', 'verify_slp.js');

    it('harus menampilkan pesan bantuan dan keluar dengan kode 0 saat --help dipanggil', async () => {
      const child = spawn(process.execPath, [cliScriptPath, '--help']);
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(exitCode, 0);
      assert.match(stdout, /BANTUAN PENGGUNAAN/i);
    });

    it('harus keluar dengan exit code 0 dan format JSON valid saat menggunakan flag --json', async () => {
      const child = spawn(process.execPath, [
        cliScriptPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(mockPort),
        '--json'
      ]);

      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(exitCode, 0);

      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.success, true);
      assert.equal(parsed.server.online, true);
      assert.equal(parsed.server.players.online, 1);
    });

    it('harus keluar dengan exit code 0 saat memvalidasi bot yang ada dengan flag --bot dan --json', async () => {
      const child = spawn(process.execPath, [
        cliScriptPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(mockPort),
        '--bot',
        'Bot_AI_Companion',
        '--json'
      ]);

      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(exitCode, 0);

      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.success, true);
      assert.equal(parsed.verification.botFound, true);
      assert.equal(parsed.verification.isOnline, true);
    });

    it('harus keluar dengan exit code 1 saat query ke host yang mati dengan --json', async () => {
      const child = spawn(process.execPath, [
        cliScriptPath,
        '--host',
        '127.0.0.1',
        '--port',
        '59124',
        '--timeout',
        '500',
        '--json'
      ]);

      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(exitCode, 1);

      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.success, false);
      assert.equal(parsed.server.online, false);
    });

    it('harus menghasilkan output visual yang rapi dalam Bahasa Indonesia', async () => {
      const child = spawn(process.execPath, [
        cliScriptPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(mockPort),
        '--bot',
        'Bot_AI_Companion'
      ]);

      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(exitCode, 0);
      assert.match(stdout, /VERIFIKASI STATUS SERVER & BOT/i);
      assert.match(stdout, /Bot_AI_Companion/);
      assert.match(stdout, /VERIFIKASI SLP BERHASIL/i);
    });
  });

  describe('6. Pengujian Integrasi Live Server (atoms-girl.tun.ply.gg:25565)', () => {
    it('harus dapat mengkueri server live jika jaringan tersedia', async (t) => {
      try {
        const liveStatus = await querySLP({
          host: 'atoms-girl.tun.ply.gg',
          port: 25565,
          timeoutMs: 6000
        });

        assert.ok(liveStatus, 'Respons status server live tidak boleh null');
        assert.ok(liveStatus.version, 'Objek version harus ada');
        assert.ok(typeof liveStatus.players.online === 'number');
        assert.ok(liveStatus.latencyMs >= 0);
      } catch (err) {
        // Jika jaringan publik atau proxy ply.gg sedang tidak dapat diakses sementara di lingkungan pengujian
        t.skip(`Koneksi server live ply.gg dilewati karena masalah jaringan: ${err.message}`);
      }
    });
  });
});
