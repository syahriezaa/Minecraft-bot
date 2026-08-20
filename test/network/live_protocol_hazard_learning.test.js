/**
 * @file live_protocol_hazard_learning.test.js
 * @description Uji "reactive hazard learning": kalau bot berulang kali kena damage di blok yang
 * sama tanpa ada mob hostile di dekatnya, blok itu otomatis ditandai berbahaya - ditemukan dari
 * bug live nyata di mana blok yang ter-resolve sebagai "glow_lichen" (harusnya tidak berbahaya di
 * Minecraft vanilla) ternyata membunuh bot berulang kali di server modded ini. Root cause pastinya
 * (ID registry bergeser akibat mod, atau trap datapack custom) tidak bisa dipastikan tanpa akses
 * data mod server, jadi solusinya belajar dari damage nyata, bukan menebak nama blok spesifik.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mcProtocol = require('minecraft-protocol');
const { LiveProtocolClient, writeVarInt } = require('../../src/network/liveProtocolClient.js');

const REF_VERSION = '1.21.11';
const serializer = mcProtocol.createSerializer({ state: mcProtocol.states.PLAY, isServer: true, version: REF_VERSION });

function readVarIntLocal(buf, offset) {
  let value = 0, size = 0;
  while (true) {
    const b = buf[offset + size];
    value |= (b & 0x7F) << (7 * size);
    size++;
    if ((b & 0x80) === 0) return { value, size };
  }
}

function chunkPacketBody({ chunkX, chunkZ, blockStateId }) {
  const solidBlockCount = Buffer.alloc(2); solidBlockCount.writeInt16BE(4096, 0);
  const fluidCount = Buffer.alloc(2); fluidCount.writeInt16BE(0, 0);
  const blockStatesContainer = Buffer.concat([Buffer.from([0]), writeVarInt(blockStateId)]);
  const biomesContainer = Buffer.concat([Buffer.from([0]), writeVarInt(0)]);
  const chunkData = Buffer.concat([solidBlockCount, fluidCount, blockStatesContainer, biomesContainer]);

  const full = serializer.createPacketBuffer({
    name: 'map_chunk',
    params: {
      x: chunkX, z: chunkZ, heightmaps: [], chunkData, blockEntities: [],
      skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [],
      skyLight: [], blockLight: []
    }
  });
  const idRes = readVarIntLocal(full, 0);
  return full.subarray(idRes.size);
}

function healthPacketBody(health) {
  const buf = Buffer.alloc(5);
  buf.writeFloatBE(health, 0);
  writeVarInt(20).copy(buf, 4);
  return buf.subarray(0, 4 + writeVarInt(20).length);
}

function setup(stateId = 999) {
  const client = new LiveProtocolClient({ username: 'HazardTest', autoReconnect: false });
  client.protocolState = 'play';
  client.position = { x: 5, y: -64, z: 5 }; // section 0 dari worldMinY default (-64)
  client.health = 20;
  client._handlePlayPacket(0x2d, chunkPacketBody({ chunkX: 0, chunkZ: 0, blockStateId: stateId }));
  return client;
}

describe('Reactive hazard learning', () => {
  it('satu kali damage saja BELUM cukup untuk menandai blok sebagai hazard', () => {
    const client = setup();
    client._handlePlayPacket(0x68, healthPacketBody(15));

    assert.equal(client.learnedHazardStateIds.size, 0);
  });

  it('dua kali damage berturut-turut di blok yang sama tanpa mob nearby -> blok ditandai hazard', () => {
    const client = setup(999);
    client._handlePlayPacket(0x68, healthPacketBody(15));
    client._handlePlayPacket(0x68, healthPacketBody(10));

    assert.equal(client.learnedHazardStateIds.has(999), true);
  });

  it('emit event hazard_learned saat blok baru dipelajari', () => {
    const client = setup(999);
    let learned = null;
    client.on('hazard_learned', (e) => { learned = e; });

    client._handlePlayPacket(0x68, healthPacketBody(15));
    client._handlePlayPacket(0x68, healthPacketBody(10));

    assert.ok(learned);
    assert.equal(learned.stateId, 999);
  });

  it('TIDAK boleh belajar hazard kalau ada mob hostile di dekatnya (supaya tidak salah kira combat sebagai jebakan blok)', () => {
    const client = setup(999);
    // spawn creeper dekat bot
    const mcData = require('minecraft-data')(REF_VERSION);
    const mappings = mcData.protocol.play.toClient.types.packet[1][0].type[1].mappings;
    let spawnId = null;
    for (const [id, name] of Object.entries(mappings)) if (name === 'spawn_entity') spawnId = parseInt(id, 16);
    const spawnBody = (() => {
      const full = serializer.createPacketBuffer({
        name: 'spawn_entity',
        params: {
          entityId: 1, objectUUID: '00000000-0000-0000-0000-000000000000', type: 32,
          x: client.position.x + 1, y: client.position.y, z: client.position.z,
          velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0, objectData: 0
        }
      });
      const idRes = readVarIntLocal(full, 0);
      return full.subarray(idRes.size);
    })();
    client._handlePlayPacket(0x01, spawnBody);

    client._handlePlayPacket(0x68, healthPacketBody(15));
    client._handlePlayPacket(0x68, healthPacketBody(10));

    assert.equal(client.learnedHazardStateIds.size, 0, 'tidak boleh belajar hazard karena ada creeper di dekatnya');
  });

  it('damage di posisi yang BERBEDA setiap kali tidak boleh dianggap konsisten (streak harus reset)', () => {
    const client = setup(999);
    client._handlePlayPacket(0x68, healthPacketBody(15));
    client.position = { x: 50, y: -64, z: 50 }; // pindah jauh, blok beda
    client._handlePlayPacket(0x68, healthPacketBody(10));

    assert.equal(client.learnedHazardStateIds.size, 0);
  });

  it('getBlockName harus mengembalikan penanda hazard, bukan nama asli, untuk stateId yang sudah dipelajari', () => {
    const client = setup(999);
    client._handlePlayPacket(0x68, healthPacketBody(15));
    client._handlePlayPacket(0x68, healthPacketBody(10));

    const name = client.getBlockName(5, -64, 5);
    assert.equal(name, '__reactive_hazard__');
  });
});
