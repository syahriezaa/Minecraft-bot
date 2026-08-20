/**
 * @file proposed_live_protocol_test.js
 * @description Suite pengujian unit untuk Packet Codecs, Framer, Kompresi, dan State Transitions pada Protokol 775.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  LiveProtocolClient,
  PacketFramer,
  CompressionHandler,
  PROTOCOL_STATES,
  CONNECTION_STATES,
  writeVarInt,
  readVarInt,
  writeVarLong,
  readVarLong,
  writeString,
  readString,
  encodeMovementFlags,
  decodeMovementFlags,
  generateOfflineUuid
} = require('./proposed_liveProtocolClient.js');

describe('Pengujian Codec Protokol 775 & LiveProtocolClient', () => {

  describe('1. Uji Encoding & Decoding VarInt / VarLong', () => {
    it('harus mengkodekan dan mendekodekan berbagai nilai integer VarInt secara presisi', () => {
      const sampleValues = [0, 1, 2, 127, 128, 255, 25565, 2097151, 2147483647];
      for (const val of sampleValues) {
        const encoded = writeVarInt(val);
        const decoded = readVarInt(encoded, 0);
        assert.ok(decoded, `VarInt gagal dibaca untuk nilai ${val}`);
        assert.equal(decoded.value, val, `Nilai VarInt tidak cocok untuk ${val}`);
      }
    });

    it('harus mengembalikan null jika buffer VarInt belum lengkap', () => {
      const incomplete = Buffer.from([0x80]); // MSB aktif tapi tidak ada byte kelanjutan
      const decoded = readVarInt(incomplete, 0);
      assert.equal(decoded, null);
    });

    it('harus mengkodekan dan mendekodekan VarLong 64-bit secara presisi', () => {
      const longValues = [0n, 1n, 127n, 128n, 2147483647n, 9223372036854775807n];
      for (const val of longValues) {
        const encoded = writeVarLong(val);
        const decoded = readVarLong(encoded, 0);
        assert.ok(decoded, `VarLong gagal dibaca untuk nilai ${val}`);
        assert.equal(decoded.value, val, `Nilai VarLong tidak cocok untuk ${val}`);
      }
    });

    it('harus membaca dan menulis string UTF-8 dengan prefiks VarInt panjang', () => {
      const text = 'Halo Minecraft NeoForge 26.1.2 Protokol 775!';
      const encoded = writeString(text);
      const decoded = readString(encoded, 0);
      assert.ok(decoded);
      assert.equal(decoded.value, text);
    });
  });

  describe('2. Uji Bitflags MovementFlags Protokol 775', () => {
    it('harus mengonversi bitflags onGround dan hasHorizontalCollision secara akurat', () => {
      assert.equal(encodeMovementFlags({ onGround: false, hasHorizontalCollision: false }), 0);
      assert.equal(encodeMovementFlags({ onGround: true, hasHorizontalCollision: false }), 1);
      assert.equal(encodeMovementFlags({ onGround: false, hasHorizontalCollision: true }), 2);
      assert.equal(encodeMovementFlags({ onGround: true, hasHorizontalCollision: true }), 3);

      assert.deepEqual(decodeMovementFlags(0), { onGround: false, hasHorizontalCollision: false });
      assert.deepEqual(decodeMovementFlags(1), { onGround: true, hasHorizontalCollision: false });
      assert.deepEqual(decodeMovementFlags(2), { onGround: false, hasHorizontalCollision: true });
      assert.deepEqual(decodeMovementFlags(3), { onGround: true, hasHorizontalCollision: true });
    });
  });

  describe('3. Uji Packet Framer & Buffer Accumulator (Fragmentasi & Coalescing TCP)', () => {
    let framer;

    beforeEach(() => {
      framer = new PacketFramer();
    });

    it('harus mengekstrak beberapa paket yang tergabung dalam 1 frame TCP (Coalesced)', () => {
      const p1 = Buffer.from('PaketSatu');
      const p2 = Buffer.from('PaketDuaPanjangSekali');
      const frame1 = Buffer.concat([writeVarInt(p1.length), p1]);
      const frame2 = Buffer.concat([writeVarInt(p2.length), p2]);
      const coalesced = Buffer.concat([frame1, frame2]);

      framer.append(coalesced);

      const r1 = framer.readNextFrame();
      const r2 = framer.readNextFrame();
      const r3 = framer.readNextFrame();

      assert.ok(r1);
      assert.equal(r1.toString(), 'PaketSatu');
      assert.ok(r2);
      assert.equal(r2.toString(), 'PaketDuaPanjangSekali');
      assert.equal(r3, null);
    });

    it('harus menangani pecahan paket yang datang byte-per-byte (Split/Fragmented)', () => {
      const p = Buffer.from('PecahanPaketJaringan');
      const fullFrame = Buffer.concat([writeVarInt(p.length), p]);

      // Kirim sebagian (hanya 3 byte pertama)
      framer.append(fullFrame.subarray(0, 3));
      assert.equal(framer.readNextFrame(), null);

      // Kirim sisa byte
      framer.append(fullFrame.subarray(3));
      const extracted = framer.readNextFrame();
      assert.ok(extracted);
      assert.equal(extracted.toString(), 'PecahanPaketJaringan');
    });
  });

  describe('4. Uji Compression Handler (Zlib Thresholding)', () => {
    let compression;

    beforeEach(() => {
      compression = new CompressionHandler();
    });

    it('harus melewati paket tanpa kompresi jika threshold = -1', () => {
      compression.setThreshold(-1);
      const data = Buffer.from('DataTanpaKompresi');
      const compressed = compression.compress(data);

      // Framer memotong panjang paket, sisanya dikirim ke decompress
      const lenRes = readVarInt(compressed, 0);
      const body = compressed.subarray(lenRes.size);
      const decompressed = compression.decompress(body);

      assert.equal(decompressed.toString(), data.toString());
    });

    it('harus menggunakan DataLength = 0 untuk paket di bawah ambang batas kompresi', () => {
      compression.setThreshold(256);
      const smallData = Buffer.from('PaketKecilDiBawahThreshold');
      const framed = compression.compress(smallData);

      const lenRes = readVarInt(framed, 0);
      const body = framed.subarray(lenRes.size);

      // Cek bahwa dataLength di body bernilai 0
      const dataLenRes = readVarInt(body, 0);
      assert.equal(dataLenRes.value, 0);

      const decompressed = compression.decompress(body);
      assert.equal(decompressed.toString(), smallData.toString());
    });

    it('harus mengompresi Zlib secara penuh untuk paket di atas ambang batas (>= 256 bytes)', () => {
      compression.setThreshold(256);
      const largeData = Buffer.alloc(1024, 'X');
      const framed = compression.compress(largeData);

      const lenRes = readVarInt(framed, 0);
      const body = framed.subarray(lenRes.size);

      const dataLenRes = readVarInt(body, 0);
      assert.equal(dataLenRes.value, 1024);

      const decompressed = compression.decompress(body);
      assert.equal(decompressed.length, 1024);
      assert.equal(decompressed.toString(), largeData.toString());
    });
  });

  describe('5. Uji Inisialisasi & Helper LiveProtocolClient', () => {
    it('harus menghasilkan UUID offline yang konsisten dan valid RFC 4122', () => {
      const uuid1 = generateOfflineUuid('Bot_Tester');
      const uuid2 = generateOfflineUuid('Bot_Tester');
      assert.equal(uuid1, uuid2);
      assert.match(uuid1, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('harus menginisialisasi LiveProtocolClient dengan status awal yang benar', () => {
      const client = new LiveProtocolClient({ username: 'CompanionBot' });
      assert.equal(client.protocolState, PROTOCOL_STATES.HANDSHAKING);
      assert.equal(client.connectionState, CONNECTION_STATES.DISCONNECTED);
      assert.equal(client.config.username, 'CompanionBot');
      assert.equal(client.config.protocolVersion, 775);
    });
  });
});
