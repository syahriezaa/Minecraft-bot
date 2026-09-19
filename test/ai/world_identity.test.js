const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { resolveWorldIdentity } = require('../../src/ai/worldIdentity');
const { SwarmTaskBoard } = require('../../src/ai/swarmTaskBoard');

test('memilih identitas relay aktif walau port UI masih memakai default', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  new SwarmTaskBoard(memory);
  const now = 100000;
  memory.observe({ world: 'atoms-girl.tun.ply.gg:53635', dimension: 'overworld', observer: 'worker', observedAt: now,
    blocks: [{ name: 'stone', position: { x: 0, y: 64, z: 0 } }] });

  assert.equal(resolveWorldIdentity(memory, { host: 'atoms-girl.tun.ply.gg', port: 25565, now }), 'atoms-girl.tun.ply.gg:53635');
});

test('heartbeat agent yang hidup lebih baru mengalahkan port relay lama', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  new SwarmTaskBoard(memory);
  const now = 100000;
  memory.observe({ world: 'atoms-girl.tun.ply.gg:53635', dimension: 'overworld', observer: 'old', observedAt: now - 10000,
    blocks: [{ name: 'stone', position: { x: 0, y: 64, z: 0 } }] });
  memory.db.prepare(`INSERT INTO swarm_agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('atoms-girl.tun.ply.gg:54100', 'overworld', 'live', '[]', 'ONLINE', null, '{}', '{}', now);

  assert.equal(resolveWorldIdentity(memory, { host: 'ATOMS-GIRL.TUN.PLY.GG', port: 25565, now }), 'atoms-girl.tun.ply.gg:54100');
});

test('menghormati world eksplisit dan fallback saat tidak ada bukti live', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  assert.equal(resolveWorldIdentity(memory, { host: 'server.test', port: 25565, world: 'custom-world' }), 'custom-world');
  assert.equal(resolveWorldIdentity(memory, { host: 'server.test', port: 25565, now: 100000 }), 'server.test:25565');
});

test('mempertahankan identitas logical world terakhir setelah worker berhenti', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  memory.observe({ world: 'atoms-girl.tun.ply.gg:53635', dimension: 'overworld', observer: 'old-worker', observedAt: 100000,
    blocks: [{ name: 'stone', position: { x: 0, y: 64, z: 0 } }] });

  assert.equal(resolveWorldIdentity(memory, { host: 'atoms-girl.tun.ply.gg', port: 25565, now: 900000 }), 'atoms-girl.tun.ply.gg:53635');
});
