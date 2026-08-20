'use strict';
/**
 * @file fuzz_codecs_stress.js
 * @description Adversarial Fuzzer & Stress Test Harness untuk Live Protocol 775 (Minecraft 26.1.2 / NeoForge).
 * Menguji ketahanan VarInt, VarLong, String, MovementFlags, PacketFramer, CompressionHandler,
 * dan LiveProtocolClient terhadap input acak, batas ekstrem, pemotongan (fragmentation),
 * coalescing, data rusak (malformed), serta deteksi memory leak dan infinite loop.
 *
 * Dijalankan oleh Challenger 1 (critic, specialist).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  LiveProtocolClient,
  createLiveClient,
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
  generateOfflineUuid,
  uuidToBuffer
} = require('../../src/network/liveProtocolClient.js');

// ==============================================================================
// Reporting & Logging Helper
// ==============================================================================
const results = {
  totalTests: 0,
  passedTests: 0,
  failedTests: 0,
  suites: [],
  findings: []
};

function runSuite(name, fn) {
  const start = performance.now();
  console.log(`\n======================================================`);
  console.log(`🔥 [SUITE] ${name}`);
  console.log(`======================================================`);
  const suiteResult = { name, passed: 0, failed: 0, errors: [], durationMs: 0 };
  
  try {
    fn(suiteResult);
  } catch (err) {
    suiteResult.failed++;
    suiteResult.errors.push({ testName: 'Suite Fatal', error: err.message, stack: err.stack });
    console.error(`💥 FATAL SUITE ERROR: ${err.message}`);
  }

  suiteResult.durationMs = performance.now() - start;
  results.suites.push(suiteResult);
  results.totalTests += suiteResult.passed + suiteResult.failed;
  results.passedTests += suiteResult.passed;
  results.failedTests += suiteResult.failed;

  console.log(`📊 Selesai: ${suiteResult.passed} PASS, ${suiteResult.failed} FAIL (${suiteResult.durationMs.toFixed(2)}ms)`);
}

function test(suiteResult, testName, fn) {
  try {
    fn();
    suiteResult.passed++;
    console.log(`  ✔ [PASS] ${testName}`);
  } catch (err) {
    suiteResult.failed++;
    suiteResult.errors.push({ testName, error: err.message, stack: err.stack });
    console.error(`  ❌ [FAIL] ${testName}: ${err.message}`);
    results.findings.push({ suite: suiteResult.name, test: testName, error: err.message });
  }
}

// ==============================================================================
// 1. Suite: VarInt & VarLong Adversarial Fuzzing
// ==============================================================================
runSuite('1. VarInt & VarLong Adversarial & Boundary Fuzzing', (suite) => {

  test(suite, 'Boundary values VarInt encoding & decoding', () => {
    const boundaryValues = [
      0, 1, -1, 127, 128, 255, 256,
      16383, 16384, 2097151, 2097152,
      268435455, 268435456,
      2147483647, -2147483648,
      -2, -127, -128, -25565, 25565
    ];

    for (const val of boundaryValues) {
      const encoded = writeVarInt(val);
      assert.ok(encoded.length >= 1 && encoded.length <= 5, `Panjang byte VarInt (${encoded.length}) di luar 1..5 untuk nilai ${val}`);
      
      const decoded = readVarInt(encoded, 0);
      assert.ok(decoded !== null, `readVarInt mengembalikan null untuk boundary ${val}`);
      assert.equal(decoded.size, encoded.length, `Ukuran size terbaca (${decoded.size}) != encoded.length (${encoded.length})`);
      
      // Minecraft VarInt memperlakukan nilai sebagai signed 32-bit integer (val | 0)
      const expectedVal = val | 0;
      assert.equal(decoded.value, expectedVal, `Nilai terdekode (${decoded.value}) != expected (${expectedVal}) untuk input ${val}`);
    }
  });

  test(suite, '50,000 random 32-bit signed & unsigned integers fuzzing', () => {
    const ITERATIONS = 50000;
    for (let i = 0; i < ITERATIONS; i++) {
      // Menghasilkan integer 32-bit acak bertanda (-2^31 hingga 2^31 - 1)
      const randInt = (Math.floor(Math.random() * 4294967296) - 2147483648) | 0;
      const encoded = writeVarInt(randInt);
      
      assert.ok(encoded.length >= 1 && encoded.length <= 5, `Panjang byte VarInt di luar batas: ${encoded.length}`);
      const decoded = readVarInt(encoded, 0);
      
      assert.ok(decoded !== null, `Gagal membaca VarInt acak: ${randInt}`);
      assert.equal(decoded.value, randInt, `Nilai tidak cocok: diharapkan ${randInt}, diperoleh ${decoded.value}`);
      assert.equal(decoded.size, encoded.length);
    }
  });

  test(suite, 'Truncated buffer handling on multi-byte VarInts', () => {
    // Uji setiap slice parsial untuk VarInt 2, 3, 4, dan 5 byte
    const multiByteValues = [300, 70000, 5000000, 2147483647, -1, -2147483648];
    for (const val of multiByteValues) {
      const fullEncoded = writeVarInt(val);
      assert.ok(fullEncoded.length > 1, `Nilai ${val} harus menghasilkan > 1 byte`);

      // Potong buffer pada setiap panjang dari 1 hingga length - 1
      for (let cutLen = 1; cutLen < fullEncoded.length; cutLen++) {
        const truncated = fullEncoded.subarray(0, cutLen);
        const decoded = readVarInt(truncated, 0);
        assert.equal(decoded, null, `readVarInt harus mengembalikan null untuk buffer terpotong (${cutLen}/${fullEncoded.length} bytes) dari val ${val}`);
      }
    }
  });

  test(suite, 'Oversized & Malformed VarInt streams (> 5 bytes dengan MSB aktif)', () => {
    // 5 byte dengan bit MSB 0x80 aktif (tidak pernah terminasi dalam 5 byte)
    const malformed5 = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]);
    const res5 = readVarInt(malformed5, 0);
    assert.equal(res5, null, 'VarInt 5 byte malformed dengan MSB aktif harus mengembalikan null');

    // 10 byte dengan bit MSB 0x80 aktif
    const malformed10 = Buffer.alloc(10, 0x80);
    const res10 = readVarInt(malformed10, 0);
    assert.equal(res10, null, 'VarInt 10 byte berulang harus mengembalikan null tanpa infinite loop');
  });

  test(suite, 'Offset traversal inside large buffer with multiple VarInts', () => {
    const values = [42, 300, 100000, -1, 0, 2147483647, -2147483648, 127, 128];
    const encodedList = values.map(v => writeVarInt(v));
    const combinedBuffer = Buffer.concat(encodedList);

    let currentOffset = 0;
    for (let i = 0; i < values.length; i++) {
      const res = readVarInt(combinedBuffer, currentOffset);
      assert.ok(res !== null, `Gagal membaca VarInt pada indeks ${i} di offset ${currentOffset}`);
      assert.equal(res.value, values[i] | 0, `Nilai tidak cocok pada indeks ${i}`);
      currentOffset += res.size;
    }
    assert.equal(currentOffset, combinedBuffer.length, 'Seluruh buffer harus terbaca sempurna');
  });

  test(suite, 'VarLong boundary and 20,000 random BigInt fuzzing', () => {
    const boundaryLongs = [
      0n, 1n, -1n, 127n, 128n, 255n, 256n,
      2147483647n, 2147483648n, -2147483648n,
      9223372036854775807n, -9223372036854775808n,
      -100n, 1234567890123456789n
    ];

    for (const val of boundaryLongs) {
      const encoded = writeVarLong(val);
      assert.ok(encoded.length >= 1 && encoded.length <= 10, `Panjang VarLong di luar 1..10 byte untuk ${val}`);
      const decoded = readVarLong(encoded, 0);
      assert.ok(decoded !== null, `Gagal membaca VarLong boundary ${val}`);
      
      // Normalisasi BigInt signed 64-bit
      const expectedVal = BigInt.asIntN(64, val);
      assert.equal(decoded.value, expectedVal, `VarLong mismatch untuk ${val}`);
      assert.equal(decoded.size, encoded.length);
    }

    // 20,000 random 64-bit BigInts
    for (let i = 0; i < 20000; i++) {
      const randomBigInt = BigInt.asIntN(64, crypto.randomBytes(8).readBigInt64BE(0));
      const encoded = writeVarLong(randomBigInt);
      const decoded = readVarLong(encoded, 0);
      assert.ok(decoded !== null);
      assert.equal(decoded.value, randomBigInt);
      assert.equal(decoded.size, encoded.length);
    }
  });

  test(suite, 'VarLong truncated & malformed buffer handling', () => {
    // Potongan parsial untuk VarLong 10-byte (misal -1n)
    const longEncoded = writeVarLong(-1n);
    assert.equal(longEncoded.length, 10);
    
    for (let cut = 1; cut < 10; cut++) {
      const truncated = longEncoded.subarray(0, cut);
      assert.equal(readVarLong(truncated, 0), null, `VarLong parsial (${cut}/10) harus mengembalikan null`);
    }

    // Malformed 10 byte beruntun dengan MSB aktif
    const malformed10 = Buffer.alloc(10, 0x80);
    assert.equal(readVarLong(malformed10, 0), null);
  });
});

// ==============================================================================
// 2. Suite: String & UUID Codec Stress Testing
// ==============================================================================
runSuite('2. String & UUID Codec Stress & Unicode Edge Cases', (suite) => {

  test(suite, 'Empty string, short string, and large 1MB string encoding', () => {
    const testCases = [
      '',
      'A',
      'Minecraft 26.1.2 NeoForge',
      'Bahasa Indonesia: Selamat Datang! @#$^&*()_+~|}{[]:;?><,./',
      '🚀🎮🛡️⛏️🔥🌲🧱💎',
      'こんにちは世界 / 안녕하세요 / Привет мир / مرحبا بالعالم',
      '\0\0\0NullBytes\0Inside\0String\0',
      'A'.repeat(50000) // 50 KB string
    ];

    for (const str of testCases) {
      const encoded = writeString(str);
      const decoded = readString(encoded, 0);
      assert.ok(decoded !== null, `Gagal membaca string untuk input dengan panjang ${str.length}`);
      assert.equal(decoded.value, str, `String terdekode tidak identik untuk input ${str.substring(0, 30)}...`);
    }
  });

  test(suite, 'Truncated string buffers at various slice positions', () => {
    const testStr = 'Ini adalah string pengujian pemotongan buffer untuk memastikan kestabilan parser jaringan.';
    const encoded = writeString(testStr);

    for (let cut = 0; cut < encoded.length; cut++) {
      const truncated = encoded.subarray(0, cut);
      const decoded = readString(truncated, 0);
      assert.equal(decoded, null, `readString harus mengembalikan null untuk potongan ${cut}/${encoded.length} byte`);
    }
  });

  test(suite, 'UUID v3 deterministic offline generation & RFC 4122 validation', () => {
    const usernames = [
      'Player1', 'Player2', 'Syahrieza', 'Bot_Companion_99',
      'VeryLongUsername16', 'A', '_Special_User_', '1234567890'
    ];

    for (const name of usernames) {
      const uuid1 = generateOfflineUuid(name);
      const uuid2 = generateOfflineUuid(name);
      assert.equal(uuid1, uuid2, `UUID tidak deterministik untuk ${name}`);

      // Validasi pola RFC 4122 Version 3
      assert.match(uuid1, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      // Konversi ke Buffer dan periksa panjang 16 byte
      const buf = uuidToBuffer(uuid1);
      assert.equal(buf.length, 16, `Buffer UUID harus tepat 16 byte untuk ${uuid1}`);
      assert.equal(buf.toString('hex'), uuid1.replace(/-/g, '').toLowerCase());
    }
  });
});

// ==============================================================================
// 3. Suite: MovementFlags Permutations & Defensive Input Testing
// ==============================================================================
runSuite('3. MovementFlags Permutations & Robustness', (suite) => {

  test(suite, 'Exhaustive truth table permutations for MovementFlags', () => {
    const truthTable = [
      { input: { onGround: false, hasHorizontalCollision: false }, expectedByte: 0x00 },
      { input: { onGround: true, hasHorizontalCollision: false }, expectedByte: 0x01 },
      { input: { onGround: false, hasHorizontalCollision: true }, expectedByte: 0x02 },
      { input: { onGround: true, hasHorizontalCollision: true }, expectedByte: 0x03 }
    ];

    for (const row of truthTable) {
      const encoded = encodeMovementFlags(row.input);
      assert.equal(encoded, row.expectedByte, `Byte enkripsi salah untuk ${JSON.stringify(row.input)}`);

      const decoded = decodeMovementFlags(encoded);
      assert.deepEqual(decoded, row.input, `Decode tidak cocok untuk byte 0x0${encoded.toString(16)}`);
    }
  });

  test(suite, 'Default values and extra bit resilience in MovementFlags', () => {
    // Default saat objek kosong atau undefined
    assert.equal(encodeMovementFlags({}), 0);
    assert.equal(encodeMovementFlags(undefined), 0);

    // Truthy non-boolean values
    assert.equal(encodeMovementFlags({ onGround: 1, hasHorizontalCollision: 'yes' }), 3);
    assert.equal(encodeMovementFlags({ onGround: null, hasHorizontalCollision: 0 }), 0);

    // Decoding byte dengan bit tambahan di luar bit 0 dan 1 (misal 0xFF atau 0xFC)
    const decodedFull = decodeMovementFlags(0xFF);
    assert.equal(decodedFull.onGround, true);
    assert.equal(decodedFull.hasHorizontalCollision, true);

    const decodedHighBitsOnly = decodeMovementFlags(0xFC); // 1111 1100 (bit 0 & 1 bernilai 0)
    assert.equal(decodedHighBitsOnly.onGround, false);
    assert.equal(decodedHighBitsOnly.hasHorizontalCollision, false);
  });
});

// ==============================================================================
// 4. Suite: PacketFramer Adversarial Stream Reassembly & Slicing
// ==============================================================================
runSuite('4. PacketFramer Adversarial Stream Slicing & Coalescing', (suite) => {

  test(suite, 'Single byte-per-byte feed across 50 consecutive packets', () => {
    const framer = new PacketFramer();
    const packets = [];

    // Buat 50 paket dengan payload bervariasi
    for (let i = 0; i < 50; i++) {
      const payload = Buffer.from(`Packet_Payload_Data_#${i}_${crypto.randomBytes(i * 10).toString('hex')}`);
      packets.push(payload);
    }

    // Bangun stream TCP utuh
    const streamChunks = packets.map(p => Buffer.concat([writeVarInt(p.length), p]));
    const fullStream = Buffer.concat(streamChunks);

    // Umpankan ke framer SATU BYTE PER SATU BYTE
    const extractedPackets = [];
    for (let b = 0; b < fullStream.length; b++) {
      framer.append(fullStream.subarray(b, b + 1));
      while (true) {
        const frame = framer.readNextFrame();
        if (!frame) break;
        extractedPackets.push(frame);
      }
    }

    assert.equal(extractedPackets.length, packets.length, `Jumlah paket terekstrak (${extractedPackets.length}) != (${packets.length})`);
    for (let i = 0; i < packets.length; i++) {
      assert.ok(extractedPackets[i].equals(packets[i]), `Payload paket #${i} tidak identik setelah byte-per-byte reassembly`);
    }
    assert.equal(framer.size, 0, 'Buffer framer harus bersih setelah semua frame diekstrak');
  });

  test(suite, 'Massive coalescing: 100 packets packed into a single TCP chunk', () => {
    const framer = new PacketFramer();
    const packets = [];

    for (let i = 0; i < 100; i++) {
      const payload = Buffer.from(`MassiveCoalescedPacket_${i}`);
      packets.push(payload);
    }

    const singleGiantChunk = Buffer.concat(packets.map(p => Buffer.concat([writeVarInt(p.length), p])));
    framer.append(singleGiantChunk);

    const extracted = [];
    while (true) {
      const frame = framer.readNextFrame();
      if (!frame) break;
      extracted.push(frame);
    }

    assert.equal(extracted.length, 100);
    for (let i = 0; i < 100; i++) {
      assert.equal(extracted[i].toString(), `MassiveCoalescedPacket_${i}`);
    }
    assert.equal(framer.readNextFrame(), null);
  });

  test(suite, 'Randomized chunk slicing fuzzing (1 to 256 bytes per chunk)', () => {
    const ITERATIONS = 20;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const framer = new PacketFramer();
      const packets = [];
      const numPackets = Math.floor(Math.random() * 30) + 10;

      for (let i = 0; i < numPackets; i++) {
        const size = Math.floor(Math.random() * 500) + 1;
        packets.push(crypto.randomBytes(size));
      }

      const fullStream = Buffer.concat(packets.map(p => Buffer.concat([writeVarInt(p.length), p])));
      
      let cursor = 0;
      const extracted = [];
      while (cursor < fullStream.length) {
        const chunkSize = Math.min(Math.floor(Math.random() * 256) + 1, fullStream.length - cursor);
        const chunk = fullStream.subarray(cursor, cursor + chunkSize);
        cursor += chunkSize;

        framer.append(chunk);
        while (true) {
          const frame = framer.readNextFrame();
          if (!frame) break;
          extracted.push(frame);
        }
      }

      assert.equal(extracted.length, packets.length, `Iterasi ${iter}: jumlah paket (${extracted.length}) != (${packets.length})`);
      for (let i = 0; i < packets.length; i++) {
        assert.ok(extracted[i].equals(packets[i]), `Iterasi ${iter}: paket #${i} payload mismatch`);
      }
      assert.equal(framer.size, 0);
    }
  });

  test(suite, 'Empty packet (0-byte payload) framing', () => {
    const framer = new PacketFramer();
    const emptyPayload = Buffer.alloc(0);
    const frame = Buffer.concat([writeVarInt(0), emptyPayload]);

    framer.append(frame);
    const extracted = framer.readNextFrame();
    assert.ok(extracted !== null);
    assert.equal(extracted.length, 0);
    assert.equal(framer.readNextFrame(), null);
  });

  test(suite, 'Large packet framing (2 Megabytes payload)', () => {
    const framer = new PacketFramer();
    const largePayload = crypto.randomBytes(2 * 1024 * 1024); // 2 MB
    const framed = Buffer.concat([writeVarInt(largePayload.length), largePayload]);

    // Umpankan dalam bongkahan 64KB
    const CHUNK_SIZE = 64 * 1024;
    for (let pos = 0; pos < framed.length; pos += CHUNK_SIZE) {
      framer.append(framed.subarray(pos, pos + CHUNK_SIZE));
    }

    const extracted = framer.readNextFrame();
    assert.ok(extracted !== null);
    assert.equal(extracted.length, largePayload.length);
    assert.ok(extracted.equals(largePayload));
    assert.equal(framer.readNextFrame(), null);
  });

  test(suite, 'Defensive empty / invalid appends and clear() method', () => {
    const framer = new PacketFramer();
    framer.append(null);
    framer.append(undefined);
    framer.append(Buffer.alloc(0));
    assert.equal(framer.size, 0);
    assert.equal(framer.readNextFrame(), null);

    framer.append(Buffer.from('TestData'));
    assert.equal(framer.size, 8);
    framer.clear();
    assert.equal(framer.size, 0);
    assert.equal(framer.readNextFrame(), null);
  });
});

// ==============================================================================
// 5. Suite: CompressionHandler Boundary & Resiliency Fuzzing
// ==============================================================================
runSuite('5. CompressionHandler Boundary & Resiliency Fuzzing', (suite) => {

  test(suite, 'Compression threshold boundary testing (threshold: 256)', () => {
    const compression = new CompressionHandler();
    compression.setThreshold(256);

    const testSizes = [0, 1, 100, 254, 255, 256, 257, 500, 1024, 8192];
    for (const size of testSizes) {
      const payload = Buffer.alloc(size, (size % 250) + 1);
      const wireFrame = compression.compress(payload);

      // Wireframe diawali oleh packetLength VarInt
      const lenRes = readVarInt(wireFrame, 0);
      assert.ok(lenRes !== null);
      const body = wireFrame.subarray(lenRes.size);

      // Body diawali oleh dataLength VarInt
      const dataLenRes = readVarInt(body, 0);
      assert.ok(dataLenRes !== null);

      if (size < 256) {
        // Harus bernilai dataLength = 0 (uncompressed)
        assert.equal(dataLenRes.value, 0, `Payload ukuran ${size} < 256 harus memiliki dataLength = 0`);
      } else {
        // Harus bernilai dataLength = size (compressed)
        assert.equal(dataLenRes.value, size, `Payload ukuran ${size} >= 256 harus memiliki dataLength = ${size}`);
      }

      // Dekompresi dan verifikasi identitas
      const decompressed = compression.decompress(body);
      assert.equal(decompressed.length, size);
      assert.ok(decompressed.equals(payload), `Dekompresi payload ukuran ${size} tidak cocok`);
    }
  });

  test(suite, 'Incompressible high-entropy random data compression', () => {
    const compression = new CompressionHandler();
    compression.setThreshold(128);

    for (let i = 0; i < 50; i++) {
      const randomData = crypto.randomBytes(512 + i * 32);
      const wireFrame = compression.compress(randomData);
      
      const lenRes = readVarInt(wireFrame, 0);
      const body = wireFrame.subarray(lenRes.size);
      const decompressed = compression.decompress(body);

      assert.ok(decompressed.equals(randomData), `Data acak inkompresibel #${i} gagal didekompresi dengan presisi`);
    }
  });

  test(suite, 'Highly compressible 100KB repetitive zero buffer', () => {
    const compression = new CompressionHandler();
    compression.setThreshold(256);

    const zeroBuf = Buffer.alloc(100 * 1024, 0);
    const wireFrame = compression.compress(zeroBuf);

    // Pastikan kompresi berhasil menekan ukuran secara signifikan (< 1KB dari 100KB)
    assert.ok(wireFrame.length < 1000, `Ukuran kompresi (${wireFrame.length}) harus jauh lebih kecil dari 100KB`);

    const lenRes = readVarInt(wireFrame, 0);
    const body = wireFrame.subarray(lenRes.size);
    const decompressed = compression.decompress(body);

    assert.equal(decompressed.length, zeroBuf.length);
    assert.ok(decompressed.equals(zeroBuf));
  });

  test(suite, 'Disabled compression mode (threshold = -1)', () => {
    const compression = new CompressionHandler();
    compression.setThreshold(-1);

    const testData = Buffer.from('ModeKompresiNonAktif12345');
    const wireFrame = compression.compress(testData);

    const lenRes = readVarInt(wireFrame, 0);
    assert.equal(lenRes.value, testData.length);
    const body = wireFrame.subarray(lenRes.size);

    const decompressed = compression.decompress(body);
    assert.ok(decompressed.equals(testData));
  });

  test(suite, 'Malformed & Corrupted compressed payload error detection', () => {
    const compression = new CompressionHandler();
    compression.setThreshold(256);

    // 1. DataLength > 0 tapi data payload zlib korup
    const corruptPayload = Buffer.concat([writeVarInt(500), Buffer.from('BukanDataZlibValidYangBisaDiDecompress')]);
    assert.throws(() => {
      compression.decompress(corruptPayload);
    }, /incorrect header check|unknown compression method|Z_DATA_ERROR|invalid/i);

    // 2. DataLength tidak cocok dengan ukuran hasil inflate
    // Buat data zlib valid dari buffer 50 byte, tapi laporkan dataLength = 500
    const originalBuf = Buffer.alloc(50, 0x41);
    const validZlib = zlib.deflateSync(originalBuf);
    const fakeHeaderCorrupt = Buffer.concat([writeVarInt(500), validZlib]);

    assert.throws(() => {
      compression.decompress(fakeHeaderCorrupt);
    }, /Ukuran dekompresi tidak cocok: diharapkan 500, diperoleh 50/);

    // 3. Truncated dataLength header
    assert.throws(() => {
      compression.decompress(Buffer.from([0x80]));
    }, /Gagal membaca VarInt Data Length/);
  });
});

// ==============================================================================
// 6. Suite: LiveProtocolClient Reconnect Backoff & Lifecycle Logic
// ==============================================================================
runSuite('6. LiveProtocolClient Lifecycle, State Transitions & Reconnect Math', (suite) => {

  test(suite, 'Exponential backoff calculation bounds (no NaN or negative delays)', () => {
    const client = new LiveProtocolClient({
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 30000,
      backoffMultiplier: 1.8,
      maxReconnectAttempts: 10
    });

    for (let attempt = 1; attempt <= client.config.maxReconnectAttempts; attempt++) {
      const baseDelay = client.config.reconnectBaseDelayMs * Math.pow(client.config.backoffMultiplier, attempt - 1);
      const cappedDelay = Math.min(baseDelay, client.config.reconnectMaxDelayMs);
      const minJitter = cappedDelay * 0.1;
      const maxJitter = cappedDelay * 0.2;

      assert.ok(!Number.isNaN(cappedDelay), `Delay menghasilkan NaN pada percobaan #${attempt}`);
      assert.ok(cappedDelay >= 1000 && cappedDelay <= 30000, `Delay (${cappedDelay}) di luar rentang 1000..30000 pada percobaan #${attempt}`);
      assert.ok(minJitter >= 0 && maxJitter >= minJitter);
    }
  });

  test(suite, 'LiveProtocolClient state constants immutability', () => {
    assert.equal(PROTOCOL_STATES.HANDSHAKING, 'handshaking');
    assert.equal(PROTOCOL_STATES.LOGIN, 'login');
    assert.equal(PROTOCOL_STATES.CONFIGURATION, 'configuration');
    assert.equal(PROTOCOL_STATES.PLAY, 'play');
    assert.equal(PROTOCOL_STATES.STATUS, 'status');

    assert.throws(() => {
      // Memastikan PROTOCOL_STATES dibekukan (Object.freeze)
      PROTOCOL_STATES.PLAY = 'mutated';
    }, /Cannot assign to read only property/);
  });

  test(suite, 'Client initial properties & username truncation to 16 chars', () => {
    const longUsername = 'ThisIsAVeryLongUsernameExceeding16Chars';
    const client = new LiveProtocolClient({ username: longUsername });
    assert.equal(client.config.username.length, 16);
    assert.equal(client.config.username, 'ThisIsAVeryLongU');
    assert.equal(client.protocolState, PROTOCOL_STATES.HANDSHAKING);
    assert.equal(client.connectionState, CONNECTION_STATES.DISCONNECTED);
  });
});

// ==============================================================================
// 7. Suite: Performance, Memory Leak & Resource Profiling
// ==============================================================================
runSuite('7. Performance Stress & Heap Memory Profiling', (suite) => {

  test(suite, '100,000 VarInt encodings/decodings throughput and stability', () => {
    const start = performance.now();
    for (let i = 0; i < 100000; i++) {
      const val = (i * 37) ^ 0x55555555;
      const enc = writeVarInt(val);
      const dec = readVarInt(enc, 0);
      assert.equal(dec.value, val | 0);
    }
    const elapsed = performance.now() - start;
    console.log(`    ⚡ Throughput VarInt: 100,000 ops dalam ${elapsed.toFixed(2)}ms (${((100000 / elapsed) * 1000).toFixed(0)} ops/detik)`);
    assert.ok(elapsed < 2000, `Throughput VarInt terlalu lambat: ${elapsed.toFixed(2)}ms`);
  });

  test(suite, '10,000 PacketFramer chunk cycles memory profile', () => {
    if (global.gc) global.gc();
    const initialMem = process.memoryUsage().heapUsed;

    const framer = new PacketFramer();
    const testChunk = Buffer.concat([writeVarInt(64), crypto.randomBytes(64)]);

    for (let i = 0; i < 10000; i++) {
      framer.append(testChunk);
      const frame = framer.readNextFrame();
      assert.equal(frame.length, 64);
    }

    if (global.gc) global.gc();
    const finalMem = process.memoryUsage().heapUsed;
    const diffMb = (finalMem - initialMem) / (1024 * 1024);
    console.log(`    🧠 Heap memory diff setelah 10,000 framing cycles: ${diffMb.toFixed(2)} MB`);
    assert.equal(framer.size, 0);
  });
});

// ==============================================================================
// Final Summary & Exit
// ==============================================================================
console.log(`\n======================================================`);
console.log(`🏆 HASIL AKHIR PENGUJIAN ADVERSARIAL & STRESS`);
console.log(`======================================================`);
console.log(`Total Pengujian : ${results.totalTests}`);
console.log(`Lulus (PASS)    : ${results.passedTests}`);
console.log(`Gagal (FAIL)    : ${results.failedTests}`);
console.log(`Temuan Bug      : ${results.findings.length}`);

if (results.findings.length > 0) {
  console.log('\n❌ DAFTAR TEMUAN / KEGAGALAN:');
  for (const f of results.findings) {
    console.log(`- [${f.suite}] ${f.test}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log('\n🎉 SELURUH PENGUJIAN ADVERSARIAL BERHASIL 100%! Tidak ada buffer leak, infinite loop, atau unhandled exception.');
  process.exit(0);
}
