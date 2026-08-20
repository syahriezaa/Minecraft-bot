/**
 * @file entity_decoder.test.js
 * @description Uji unit decoder packet entity (spawn_entity, entity_destroy, rel_entity_move).
 * Packet ID nyata (0x01 / 0x4d / 0x63) dikonfirmasi lewat capture live server atoms-girl.tun.ply.gg
 * dan divalidasi silang: entityId di entity_destroy/rel_entity_move harus cocok dengan entityId yang
 * sebelumnya benar-benar muncul di spawn_entity, dan entity type ID (10/41/32/150) cocok persis dengan
 * bat/enderman/creeper/zombie di tabel minecraft-data - bukan tebakan.
 *
 * Fixture dibangun lewat serializer resmi minecraft-protocol (bukan hand-crafted bytes).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mcProtocol = require('minecraft-protocol');

const {
  decodeSpawnEntity,
  decodeEntityDestroy,
  decodeRelEntityMove,
  resolveEntityTypeName,
  isHostileEntityName
} = require('../../src/network/entityDecoder.js');

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

function packetBody(name, params) {
  const full = serializer.createPacketBuffer({ name, params });
  const idRes = readVarIntLocal(full, 0);
  return full.subarray(idRes.size);
}

describe('decodeSpawnEntity', () => {
  it('harus mendekode entityId, type, dan posisi dari packet spawn_entity', () => {
    const body = packetBody('spawn_entity', {
      entityId: 12345,
      objectUUID: '00000000-0000-0000-0000-000000000000',
      type: 32, // creeper
      x: 10.5, y: 64, z: -5.5,
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0, yaw: 0, headPitch: 0, objectData: 0
    });

    const result = decodeSpawnEntity(body);

    assert.equal(result.entityId, 12345);
    assert.equal(result.type, 32);
    assert.equal(result.x, 10.5);
    assert.equal(result.y, 64);
    assert.equal(result.z, -5.5);
  });
});

describe('decodeEntityDestroy', () => {
  it('harus mendekode daftar entityId yang dihapus', () => {
    const body = packetBody('entity_destroy', { entityIds: [111, 222, 333] });

    const result = decodeEntityDestroy(body);

    assert.deepEqual(result.entityIds, [111, 222, 333]);
  });
});

describe('decodeRelEntityMove', () => {
  it('harus mendekode delta posisi terskala (raw/4096) menjadi satuan blok', () => {
    // dX=4096 -> 1 blok, dY=2048 -> 0.5 blok
    const body = packetBody('rel_entity_move', { entityId: 111, dX: 4096, dY: 2048, dZ: -4096, onGround: true });

    const result = decodeRelEntityMove(body);

    assert.equal(result.entityId, 111);
    assert.equal(result.dx, 1);
    assert.equal(result.dy, 0.5);
    assert.equal(result.dz, -1);
  });
});

describe('resolveEntityTypeName & isHostileEntityName', () => {
  it('harus meresolusi type ID nyata (dikonfirmasi live) ke nama mob yang benar', () => {
    assert.equal(resolveEntityTypeName(10), 'bat');
    assert.equal(resolveEntityTypeName(41), 'enderman');
    assert.equal(resolveEntityTypeName(32), 'creeper');
    assert.equal(resolveEntityTypeName(150), 'zombie');
  });

  it('harus mengklasifikasi mob hostile dengan benar', () => {
    assert.equal(isHostileEntityName('creeper'), true);
    assert.equal(isHostileEntityName('zombie'), true);
    assert.equal(isHostileEntityName('enderman'), true);
    assert.equal(isHostileEntityName('bat'), false, 'bat adalah mob ambient, bukan hostile');
    assert.equal(isHostileEntityName('cow'), false);
  });
});
