/**
 * @file chunkDecoder.js
 * @description Dekoder paket "Chunk Data and Update Light" (Protokol 775 / 1.21.1) menjadi
 * global block state ID per posisi, agar RichVoxelSpatialEngine bisa memakai data blok nyata
 * dari server alih-alih dunia superflat palsu (_defaultWorldProvider).
 *
 * Hanya mendekode bagian yang dibutuhkan untuk world model (chunk section: block states + biomes).
 * Heightmaps dilewati (skip, format VarInt-map - lihat skipHeightmaps), block entities & light data
 * tidak diparse karena tidak dipakai.
 */

/**
 * Duplikat minimal dari readVarInt di liveProtocolClient.js.
 * Sengaja tidak require dari sana untuk menghindari circular dependency
 * (liveProtocolClient.js men-require modul ini untuk decode packet Chunk Data).
 */
function readVarInt(buf, offset = 0) {
  if (!buf || offset >= buf.length) return null;

  let value = 0;
  let size = 0;

  while (offset + size < buf.length && size < 5) {
    const b = buf[offset + size];
    value |= (b & 0x7F) << (7 * size);
    size++;
    if ((b & 0x80) === 0) {
      return { value, size };
    }
  }

  return null;
}

/**
 * Membongkar array Long (BigInt) yang berisi entry ter-pack (bit-packed, tidak menyeberang batas long)
 * menjadi array indeks/nilai desimal biasa.
 */
function unpackLongsToIndices(longs, bitsPerEntry, entriesCount) {
  if (bitsPerEntry === 0) return new Array(entriesCount).fill(0);

  const entriesPerLong = Math.floor(64 / bitsPerEntry);
  const mask = (1n << BigInt(bitsPerEntry)) - 1n;
  const result = new Array(entriesCount);
  let written = 0;

  for (let longIdx = 0; longIdx < longs.length && written < entriesCount; longIdx++) {
    const long = longs[longIdx];
    for (let i = 0; i < entriesPerLong && written < entriesCount; i++) {
      const value = (long >> BigInt(i * bitsPerEntry)) & mask;
      result[written++] = Number(value);
    }
  }

  while (written < entriesCount) result[written++] = 0;
  return result;
}

/**
 * Mendekode satu "Paletted Container" (dipakai untuk block states maupun biomes per section).
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {{ entriesPerContainer: number, maxIndirectBits: number }} opts
 */
function decodePalettedContainer(buffer, offset, { entriesPerContainer, maxIndirectBits }) {
  let cursor = offset;
  const bitsPerEntry = buffer.readUInt8(cursor);
  cursor += 1;

  if (bitsPerEntry === 0) {
    // Mode single-valued TIDAK punya field Data Array Length/Data (dikonfirmasi dari byte nyata
    // live server - beda dari asumsi awal yang menyamakan perlakuannya dengan indirect/direct).
    const singleRes = readVarInt(buffer, cursor);
    cursor += singleRes.size;
    return { values: new Array(entriesPerContainer).fill(singleRes.value), nextOffset: cursor };
  }

  let palette = null;

  if (bitsPerEntry <= maxIndirectBits) {
    const paletteLenRes = readVarInt(buffer, cursor);
    cursor += paletteLenRes.size;
    palette = [];
    for (let i = 0; i < paletteLenRes.value; i++) {
      const entryRes = readVarInt(buffer, cursor);
      cursor += entryRes.size;
      palette.push(entryRes.value);
    }
  }
  // else: direct mode, tidak ada palette - nilai data array adalah global ID langsung.

  // Server ini (NeoForge 26.1.2 / protokol 775) memakai format "noSizePrefix": panjang data array
  // TIDAK dikirim di wire, melainkan dihitung dari bitsPerEntry & entriesPerContainer - dikonfirmasi
  // lewat prismarine-chunk (fitur versi >=1.21.5, lihat PaletteContainer.js#readBuffer di node_modules).
  const entriesPerLong = Math.floor(64 / bitsPerEntry);
  const longCount = Math.ceil(entriesPerContainer / entriesPerLong);

  const longs = new Array(longCount);
  for (let i = 0; i < longCount; i++) {
    longs[i] = buffer.readBigUInt64BE(cursor);
    cursor += 8;
  }

  const indices = unpackLongsToIndices(longs, bitsPerEntry, entriesPerContainer);
  const values = palette ? indices.map((idx) => palette[idx]) : indices;

  return { values, nextOffset: cursor };
}

const BLOCK_STATES_PER_SECTION = 16 * 16 * 16; // 4096
const BIOMES_PER_SECTION = 4 * 4 * 4; // 64
const MAX_INDIRECT_BITS_BLOCK = 8;
const MAX_INDIRECT_BITS_BIOME = 3;

// minecraft-data belum menerbitkan definisi untuk protokol 775 (NeoForge 26.1.2). Dikonfirmasi lewat
// capture live server bahwa struktur packet Chunk Data (framing chunkX/chunkZ, heightmaps, batas data)
// server ini identik dengan definisi protokol 774 (versi 1.21.11, versi terbaru yang tersedia) -
// dipakai untuk membongkar framing luar packet secara andal lewat minecraft-protocol alih-alih
// menerka-nerka ulang format heightmaps/NBT secara manual.
const DECODE_REFERENCE_VERSION = '1.21.11';

let cachedDeserializer = null;
let cachedChunkPacketId = null;

function getChunkPacketDeserializer() {
  if (!cachedDeserializer) {
    const mcProtocol = require('minecraft-protocol');
    const mcDataFactory = require('minecraft-data');
    const mcData = mcDataFactory(DECODE_REFERENCE_VERSION);
    const mappings = mcData.protocol.play.toClient.types.packet[1][0].type[1].mappings;

    for (const [id, name] of Object.entries(mappings)) {
      if (name === 'map_chunk') cachedChunkPacketId = parseInt(id, 16);
    }
    if (cachedChunkPacketId === null) {
      throw new Error(`Tidak menemukan mapping packet map_chunk pada minecraft-data ${DECODE_REFERENCE_VERSION}`);
    }

    cachedDeserializer = mcProtocol.createDeserializer({
      state: mcProtocol.states.PLAY,
      isServer: false,
      version: DECODE_REFERENCE_VERSION
    });
  }
  return { deserializer: cachedDeserializer, chunkPacketId: cachedChunkPacketId };
}

function writeVarIntLocal(value) {
  const bytes = [];
  let val = value >>> 0;
  while (true) {
    if ((val & ~0x7F) === 0) {
      bytes.push(val);
      break;
    }
    bytes.push((val & 0x7F) | 0x80);
    val >>>= 7;
  }
  return Buffer.from(bytes);
}

/**
 * Mendekode payload paket Chunk Data (setelah packet ID asli dibuang oleh liveProtocolClient).
 * Framing luar (chunkX/chunkZ, heightmaps, batas data section) dibongkar lewat minecraft-protocol
 * (definisi protokol resmi, bukan tebakan manual). Isi tiap chunk section (block states & biomes)
 * dibongkar lewat decodePalettedContainer di atas, karena prismarine-chunk membatasi bit per biome
 * maksimum 8 sedangkan server modded ini memakai registry biome lebih besar (9 bit/entry).
 */
function decodeChunkDataPacket(bodyBuffer) {
  const { deserializer, chunkPacketId } = getChunkPacketDeserializer();
  const fullPacket = Buffer.concat([writeVarIntLocal(chunkPacketId), bodyBuffer]);
  const { data } = deserializer.parsePacketBuffer(fullPacket);
  const { x: chunkX, z: chunkZ, chunkData } = data.params;

  const sections = [];
  let cursor = 0;

  while (cursor < chunkData.length) {
    cursor += 2; // Solid Block Count (int16), tidak dipakai untuk world model
    cursor += 2; // Fluid Count (int16) - field tambahan versi >=26.1, tidak dipakai untuk world model

    const blockStatesRes = decodePalettedContainer(chunkData, cursor, {
      entriesPerContainer: BLOCK_STATES_PER_SECTION,
      maxIndirectBits: MAX_INDIRECT_BITS_BLOCK
    });
    cursor = blockStatesRes.nextOffset;

    const biomesRes = decodePalettedContainer(chunkData, cursor, {
      entriesPerContainer: BIOMES_PER_SECTION,
      maxIndirectBits: MAX_INDIRECT_BITS_BIOME
    });
    cursor = biomesRes.nextOffset;

    sections.push({ blockStates: blockStatesRes.values, biomes: biomesRes.values });
  }

  return { chunkX, chunkZ, sections };
}

module.exports = {
  unpackLongsToIndices,
  decodePalettedContainer,
  decodeChunkDataPacket,
  BLOCK_STATES_PER_SECTION,
  BIOMES_PER_SECTION
};
