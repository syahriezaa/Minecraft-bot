const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  unpackLongsToIndices,
  decodePalettedContainer,
  decodeChunkDataPacket
} = require('../../src/network/chunkDecoder.js');
const { writeVarInt } = require('../../src/network/liveProtocolClient.js');

function longBuffer(values) {
  const buf = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => buf.writeBigUInt64BE(BigInt(v), i * 8));
  return buf;
}

describe('unpackLongsToIndices', () => {
  it('membongkar entry 4-bit dari satu long menjadi indeks berurutan', () => {
    // value_i disimpan di bit (i*4): 1 | (2<<4) | (3<<8) | (4<<12) | (5<<16)
    const packed = 1n | (2n << 4n) | (3n << 8n) | (4n << 12n) | (5n << 16n);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(packed, 0);

    const result = unpackLongsToIndices([buf.readBigUInt64BE(0)], 4, 5);

    assert.deepEqual(result, [1, 2, 3, 4, 5]);
  });

  it('sisa bit yang tidak terpakai di long harus terbaca sebagai 0', () => {
    const packed = 7n; // hanya entry pertama diisi
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(packed, 0);

    const result = unpackLongsToIndices([buf.readBigUInt64BE(0)], 4, 4);

    assert.deepEqual(result, [7, 0, 0, 0]);
  });
});

describe('decodePalettedContainer', () => {
  it('mode single-valued (bitsPerEntry=0) mengembalikan satu nilai untuk semua entry, tanpa field Data Array', () => {
    // Dikonfirmasi dari byte nyata live server: mode single-valued TIDAK punya Data Array Length/Data,
    // berbeda dari indirect/direct yang selalu punya field tsb.
    const buf = Buffer.concat([
      Buffer.from([0]), // bitsPerEntry
      writeVarInt(42)   // nilai tunggal - langsung berhenti di sini
    ]);

    const { values, nextOffset } = decodePalettedContainer(buf, 0, { entriesPerContainer: 8, maxIndirectBits: 8 });

    assert.deepEqual(values, new Array(8).fill(42));
    assert.equal(nextOffset, buf.length);
  });

  it('mode indirect memetakan indeks lewat tabel palette (panjang data array dihitung dari bitsPerEntry, tidak dikirim di wire)', () => {
    // 5 entry, 2 bit/entry -> indeks [0,1,2,1,0] dikemas dalam satu long
    const packed = 0n | (1n << 2n) | (2n << 4n) | (1n << 6n) | (0n << 8n);
    const buf = Buffer.concat([
      Buffer.from([2]),        // bitsPerEntry = 2 (indirect, <= maxIndirectBits)
      writeVarInt(3),          // palette length
      writeVarInt(100),
      writeVarInt(200),
      writeVarInt(300),
      longBuffer([packed])     // tanpa VarInt data array length - dihitung: ceil(5/floor(64/2))=1 long
    ]);

    const { values, nextOffset } = decodePalettedContainer(buf, 0, { entriesPerContainer: 5, maxIndirectBits: 8 });

    assert.deepEqual(values, [100, 200, 300, 200, 100]);
    assert.equal(nextOffset, buf.length);
  });

  it('mode direct membaca nilai global ID langsung tanpa tabel palette (panjang data array dihitung, bukan dikirim)', () => {
    // 4 entry, 6 bit/entry (> maxIndirectBits=3, biome direct) -> id [10,20,30,15]
    const packed = 10n | (20n << 6n) | (30n << 12n) | (15n << 18n);
    const buf = Buffer.concat([
      Buffer.from([6]), // bitsPerEntry = 6 (di atas maxIndirectBits biome=3 -> direct)
      longBuffer([packed]) // tanpa VarInt data array length - dihitung: ceil(4/floor(64/6))=1 long
    ]);

    const { values, nextOffset } = decodePalettedContainer(buf, 0, { entriesPerContainer: 4, maxIndirectBits: 3 });

    assert.deepEqual(values, [10, 20, 30, 15]);
    assert.equal(nextOffset, buf.length);
  });
});

describe('decodeChunkDataPacket', () => {
  // Fixture ini adalah payload packet 0x2d NYATA yang ditangkap langsung dari server live
  // atoms-girl.tun.ply.gg (NeoForge 26.1.2 / protokol 775), chunk (-2, -1) di sekitar area spawn.
  // Dipakai sebagai regression test karena format packet ini didekode lewat definisi protokol
  // resmi minecraft-protocol (bukan hand-crafted bytes) - hand-crafting ulang byte yang valid
  // untuk framing tsb tidak praktis dan rawan salah asumsi (lihat riwayat bug heightmaps/NBT).
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'live_chunk_data_payload.bin');
  const realChunkPayload = fs.readFileSync(fixturePath);

  it('mendekode seluruh payload chunk nyata tanpa sisa byte tak terpakai (tidak drift)', () => {
    const result = decodeChunkDataPacket(realChunkPayload);

    assert.equal(result.chunkX, -2);
    assert.equal(result.chunkZ, -1);
    assert.ok(result.sections.length > 0, 'harus menghasilkan minimal 1 section');

    for (const section of result.sections) {
      assert.equal(section.blockStates.length, 4096);
      assert.equal(section.biomes.length, 64);
      for (const id of section.blockStates) {
        assert.ok(Number.isInteger(id) && id >= 0, `block state ID harus bilangan bulat non-negatif, dapat ${id}`);
      }
    }
  });
});
