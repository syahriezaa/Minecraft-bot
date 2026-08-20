/**
 * @file live_protocol_chunk_world.test.js
 * @description Uji integrasi decoding packet Chunk Data (0x2d) ke world model LiveProtocolClient,
 * agar getBlockStateId/getBlockName membaca data blok nyata dari server, bukan dunia superflat palsu.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mcProtocol = require('minecraft-protocol');
const mcDataFactory = require('minecraft-data');
const { LiveProtocolClient } = require('../../src/network/liveProtocolClient.js');

// Paket uji dibangun lewat serializer resmi minecraft-protocol (bukan hand-crafted bytes) agar selalu
// valid terhadap definisi protokol map_chunk yang sama dipakai chunkDecoder.js untuk decode.
const DECODE_REFERENCE_VERSION = '1.21.11';
const serializer = mcProtocol.createSerializer({ state: mcProtocol.states.PLAY, isServer: true, version: DECODE_REFERENCE_VERSION });

function readVarIntLocal(buf, offset) {
  let value = 0, size = 0;
  while (true) {
    const b = buf[offset + size];
    value |= (b & 0x7F) << (7 * size);
    size++;
    if ((b & 0x80) === 0) return { value, size };
  }
}

function buildSingleValuedSection({ blockStateId, biomeId = 0 }) {
  const solidBlockCount = Buffer.alloc(2);
  solidBlockCount.writeInt16BE(4096, 0);
  const fluidCount = Buffer.alloc(2); // field tambahan format noSizePrefix/hasFluidCount (versi >=26.1)
  fluidCount.writeInt16BE(0, 0);
  const blockStatesContainer = Buffer.concat([Buffer.from([0]), Buffer.from(varint(blockStateId))]);
  const biomesContainer = Buffer.concat([Buffer.from([0]), Buffer.from(varint(biomeId))]);
  return Buffer.concat([solidBlockCount, fluidCount, blockStatesContainer, biomesContainer]);
}

function varint(value) {
  const bytes = [];
  let val = value >>> 0;
  while (true) {
    if ((val & ~0x7F) === 0) { bytes.push(val); break; }
    bytes.push((val & 0x7F) | 0x80);
    val >>>= 7;
  }
  return bytes;
}

/** Mengembalikan body packet (tanpa packet ID) seperti yang diterima liveProtocolClient dari _dispatchPacket. */
function buildChunkPacketBody({ chunkX, chunkZ, sections }) {
  const chunkData = Buffer.concat(sections);
  const fullPacket = serializer.createPacketBuffer({
    name: 'map_chunk',
    params: {
      x: chunkX, z: chunkZ,
      heightmaps: [],
      chunkData,
      blockEntities: [],
      skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [],
      skyLight: [], blockLight: []
    }
  });
  const idRes = readVarIntLocal(fullPacket, 0);
  return fullPacket.subarray(idRes.size);
}

describe('LiveProtocolClient world model dari Chunk Data packet (0x2d)', () => {
  it('harus menyimpan section chunk dan mengembalikan global block state ID nyata lewat getBlockStateId', () => {
    const client = new LiveProtocolClient({ username: 'WorldTest', autoReconnect: false });
    client.protocolState = 'play';

    // worldMinY default -64 -> section index 0 = y -64..-49. Chunk (0,0) 1 section berisi stone (id 1).
    const body = buildChunkPacketBody({
      chunkX: 0,
      chunkZ: 0,
      sections: [buildSingleValuedSection({ blockStateId: 1 })]
    });

    client._handlePlayPacket(0x2d, body);

    // y = -64 (dasar section pertama, world Y minimum default)
    assert.equal(client.getBlockStateId(5, -64, 5), 1);
    assert.equal(client.getBlockStateId(15, -49, 0), 1);
  });

  it('harus mengembalikan null untuk posisi di chunk yang belum pernah dimuat', () => {
    const client = new LiveProtocolClient({ username: 'WorldTest2', autoReconnect: false });
    client.protocolState = 'play';

    assert.equal(client.getBlockStateId(1000, 64, 1000), null);
  });

  it('getBlockName harus menerjemahkan global block state ID vanilla menjadi nama blok', () => {
    const client = new LiveProtocolClient({ username: 'WorldTest3', autoReconnect: false });
    client.protocolState = 'play';

    const body = buildChunkPacketBody({
      chunkX: 0,
      chunkZ: 0,
      sections: [buildSingleValuedSection({ blockStateId: 1 })] // id 1 = 'stone' di minecraft-data 1.21.1
    });

    client._handlePlayPacket(0x2d, body);

    assert.equal(client.getBlockName(0, -64, 0), 'stone');
  });

  it('harus meng-emit event chunk_loaded setiap kali chunk diterima', () => {
    const client = new LiveProtocolClient({ username: 'WorldTest4', autoReconnect: false });
    client.protocolState = 'play';

    let received = null;
    client.on('chunk_loaded', (d) => { received = d; });

    const body = buildChunkPacketBody({
      chunkX: 3,
      chunkZ: -7,
      sections: [buildSingleValuedSection({ blockStateId: 1 })]
    });
    client._handlePlayPacket(0x2d, body);

    assert.deepEqual(received, { chunkX: 3, chunkZ: -7, sectionCount: 1 });
  });
});
