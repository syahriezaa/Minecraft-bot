/**
 * @file live_protocol_entity_tracking.test.js
 * @description Uji integrasi tracking entity (spawn_entity 0x01, entity_destroy 0x4d) di
 * LiveProtocolClient, agar bot bisa tahu keberadaan mob hostile di sekitarnya - dasar untuk
 * hostile awareness (menghindari Creeper/Zombie dkk). Update posisi real-time (rel_entity_move)
 * belum disambungkan - lihat catatan di liveProtocolClient.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mcProtocol = require('minecraft-protocol');
const { LiveProtocolClient } = require('../../src/network/liveProtocolClient.js');

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

function spawnEntityBody({ entityId, type, x, y, z }) {
  return packetBody('spawn_entity', {
    entityId,
    objectUUID: '00000000-0000-0000-0000-000000000000',
    type, x, y, z,
    velocity: { x: 0, y: 0, z: 0 },
    pitch: 0, yaw: 0, headPitch: 0, objectData: 0
  });
}

describe('LiveProtocolClient entity tracking', () => {
  it('spawn_entity (0x01) harus menyimpan entity baru dengan nama terresolusi', () => {
    const client = new LiveProtocolClient({ username: 'EntTest1', autoReconnect: false });
    client.protocolState = 'play';
    client.position = { x: 0, y: 64, z: 0 };

    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 500, type: 32, x: 5, y: 64, z: 0 }));

    const hostiles = client.getNearbyHostiles(client.position, 50);
    assert.equal(hostiles.length, 1);
    assert.equal(hostiles[0].entityId, 500);
    assert.equal(hostiles[0].name, 'creeper');
    assert.ok(Math.abs(hostiles[0].distance - 5) < 0.001);
  });

  it('entity_destroy (0x4d) harus menghapus entity dari tracking', () => {
    const client = new LiveProtocolClient({ username: 'EntTest2', autoReconnect: false });
    client.protocolState = 'play';
    client.position = { x: 0, y: 64, z: 0 };

    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 501, type: 150, x: 3, y: 64, z: 0 }));
    assert.equal(client.getNearbyHostiles(client.position, 50).length, 1);

    client._handlePlayPacket(0x4d, packetBody('entity_destroy', { entityIds: [501] }));
    assert.equal(client.getNearbyHostiles(client.position, 50).length, 0);
  });

  it('getNearbyHostiles harus mengabaikan mob non-hostile (mis. bat) dan entity di luar jarak maksimum', () => {
    const client = new LiveProtocolClient({ username: 'EntTest4', autoReconnect: false });
    client.protocolState = 'play';
    client.position = { x: 0, y: 64, z: 0 };

    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 503, type: 10, x: 2, y: 64, z: 0 })); // bat - non hostile
    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 504, type: 32, x: 200, y: 64, z: 0 })); // creeper tapi jauh

    assert.equal(client.getNearbyHostiles(client.position, 50).length, 0);
  });

  it('getNearbyHostiles harus mengurutkan hasil dari yang terdekat', () => {
    const client = new LiveProtocolClient({ username: 'EntTest5', autoReconnect: false });
    client.protocolState = 'play';
    client.position = { x: 0, y: 64, z: 0 };

    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 505, type: 32, x: 20, y: 64, z: 0 }));
    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 506, type: 150, x: 3, y: 64, z: 0 }));

    const hostiles = client.getNearbyHostiles(client.position, 50);
    assert.equal(hostiles.length, 2);
    assert.equal(hostiles[0].entityId, 506, 'yang lebih dekat harus di urutan pertama');
    assert.equal(hostiles[1].entityId, 505);
  });

  it('tiap entity harus punya lastSeenAt, dan spawn_entity ulang (re-sighting) harus memperbarui posisi & lastSeenAt', () => {
    const client = new LiveProtocolClient({ username: 'EntTest6', autoReconnect: false });
    client.protocolState = 'play';
    client.position = { x: 0, y: 64, z: 0 };

    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 507, type: 32, x: 10, y: 64, z: 0 }));
    const first = client.getNearbyHostiles(client.position, 50)[0];
    assert.ok(typeof first.lastSeenAt === 'number' && first.lastSeenAt > 0);

    // Entity yang sama "terlihat lagi" (mis. masuk render distance bot lain / server resync) di posisi baru.
    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 507, type: 32, x: 6, y: 64, z: 0 }));
    const second = client.getNearbyHostiles(client.position, 50)[0];
    assert.equal(second.x, 6, 'posisi harus ter-update ke sighting terbaru');
    assert.ok(second.lastSeenAt >= first.lastSeenAt, 'lastSeenAt harus ikut diperbarui');
  });

  it('getAllHostiles harus mengembalikan seluruh mob hostile yang di-track tanpa perlu posisi acuan (untuk agregasi lintas-bot)', () => {
    const client = new LiveProtocolClient({ username: 'EntTest7', autoReconnect: false });
    client.protocolState = 'play';

    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 508, type: 32, x: 500, y: 64, z: 500 })); // jauh dari mana pun
    client._handlePlayPacket(0x01, spawnEntityBody({ entityId: 509, type: 10, x: 0, y: 64, z: 0 })); // bat - non hostile

    const all = client.getAllHostiles();
    assert.equal(all.length, 1);
    assert.equal(all[0].entityId, 508);
    assert.ok(typeof all[0].lastSeenAt === 'number');
  });
});
