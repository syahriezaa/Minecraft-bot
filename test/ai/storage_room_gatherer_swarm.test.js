const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { REGIONS, startStorageRoomGathererSwarm } = require('../../src/ai/runStorageRoomGathererSwarm');

test('gatherer swarm membagi seed line menjadi empat jalur frontier tanpa overlap', () => {
  const regions = REGIONS.map(raw => raw.split(',').map(Number));
  assert.equal(regions.length, 4);
  const keys = new Set();
  for (const [minX, maxX, minZ, maxZ] of regions) {
    for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1) {
      const key = `${x},${z}`;
      assert.equal(keys.has(key), false, `region overlap pada ${key}`);
      keys.add(key);
    }
  }
  assert.equal(keys.size, 4 * 28);
  assert.deepEqual(regions.map(region => [region[2], region[3]]), [
    [-406, -400], [-399, -393], [-392, -386], [-385, -379]
  ]);
  assert.ok(regions.every(region => region[0] === -66 && region[1] === -63));
});

test('gatherer swarm tidak me-restart worker yang sudah BLOCKED terminal', async t => {
  const children = [];
  const logs = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    children.push(child);
    return child;
  };
  const swarm = startStorageRoomGathererSwarm({
    count: 1,
    regions: [REGIONS[0]],
    maxRunMs: 5000,
    restartDelayMs: 10,
    spawnProcess,
    log: message => logs.push(message)
  });
  t.after(() => {
    for (const child of swarm.children) child?.kill('SIGTERM');
  });

  children[0].stdout.emit('data', 'WORK_EVENT {"phase":"BLOCKED","reason":"RETURN_FAILED:ACCESS_RETURN_FAILED:NO_VERIFIED_ACCESS_PATH"}\n');
  children[0].emit('exit', 2, null);
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(children.length, 1);
  assert.ok(logs.some(line => line.includes('"phase":"BLOCKED"') && line.includes('RETURN_FAILED')));
});
