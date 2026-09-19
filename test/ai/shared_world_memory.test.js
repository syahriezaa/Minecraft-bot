const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { attachSharedWorldObserver, worldContext } = require('../../src/ai/sharedWorldObserver');
const { SwarmTaskBoard } = require('../../src/ai/swarmTaskBoard');
const { connectedComponents, boundsOf } = require('../../src/ai/structureGeometry');
const { createLandmarkLlmClient } = require('../../src/ai/landmarkLlmClient');
const block = (x, y, z, name = 'stone') => ({ position: { x, y, z }, name });
const context = { world: 'test:25565', dimension: 'overworld', observer: 'builder' };

test('identitas koneksi tcp_dns tersedia tanpa client.options', () => {
  assert.deepEqual(worldContext({ _client: { socket: { _host: 'test', remotePort: 25565 } },
    game: { dimension: 'overworld' } }), { world: 'test:25565', dimension: 'overworld' });
});

test('memori bersama: isolasi dunia/dimensi, null, udara dan pengamatan lama', () => {
  const store = new SharedWorldMemory(':memory:');
  try {
    store.observe({ ...context, blocks: [block(1, 64, 1), null], observedAt: 10 });
    store.observe({ ...context, observer: 'farmer', blocks: [block(1, 64, 1, 'air')], observedAt: 20 });
    store.observe({ ...context, blocks: [block(1, 64, 1)], observedAt: 5 });
    assert.equal(store.getBlock(context.world, context.dimension, block(1, 64, 1).position).name, 'air');
    assert.equal(store.getBlock('other', context.dimension, block(1, 64, 1).position), null);
    assert.equal(store.getBlock(context.world, 'nether', block(1, 64, 1).position), null);
    assert.equal(store.getBlock(context.world, context.dimension, block(2, 64, 1).position), null);
  } finally { store.close(); }
});

test('bukti bertentangan ditandai dan pengamatan lebih baru menyelesaikannya', () => {
  const store = new SharedWorldMemory(':memory:');
  try {
    store.observe({ ...context, blocks: [block(0, 0, 0)], observedAt: 10 });
    store.observe({ ...context, observer: 'miner', blocks: [block(0, 0, 0, 'air')], observedAt: 10 });
    assert.equal(store.getBlock(context.world, context.dimension, block(0, 0, 0).position).needsResurvey, true);
    store.observe({ ...context, blocks: [block(0, 0, 0, 'air')], observedAt: 11 });
    assert.equal(store.getBlock(context.world, context.dimension, block(0, 0, 0).position).needsResurvey, false);
  } finally { store.close(); }
});

test('dua koneksi berbagi data persisten dan batch tidak valid tidak ditulis sebagian', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-db-'));
  const a = new SharedWorldMemory(path.join(dir, 'map.sqlite'));
  const b = new SharedWorldMemory(path.join(dir, 'map.sqlite'));
  try {
    a.observe({ ...context, blocks: [block(0, 1, 0)] });
    b.observe({ ...context, observer: 'miner', blocks: [block(1, 1, 0)] });
    assert.equal(a.summary().worlds[0].blocks, 2);
    assert.throws(() => a.observe({ ...context, blocks: [block(3, 1, 0), block(NaN, 0, 0)] }));
    assert.equal(b.summary().worlds[0].blocks, 2);
  } finally { a.close(); b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('empat proses worker menulis bersamaan tanpa kehilangan blok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-swarm-'));
  const file = path.join(dir, 'map.sqlite');
  const store = new SharedWorldMemory(file);
  const modulePath = require.resolve('../../src/ai/sharedWorldMemory');
  try {
    const results = await Promise.allSettled([0, 1, 2, 3].map(worker => new Promise((resolve, reject) => {
      const code = `const {SharedWorldMemory}=require(${JSON.stringify(modulePath)});
        const db=new SharedWorldMemory(${JSON.stringify(file)});
        for(let x=0;x<20;x++) db.observe({world:'test',dimension:'overworld',observer:'worker-${worker}',
          blocks:[{name:'stone',position:{x,y:${worker},z:0}}]}); db.close();`;
      const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      child.stderr.on('data', data => { error += data; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
    })));
    for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
    assert.equal(store.summary().worlds[0].blocks, 80);
    assert.equal(store.summary().observers.length, 4);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('observer menerima blockUpdate, tidak duplikat listener, dan membersihkan saat disconnect', () => {
  const store = new SharedWorldMemory(':memory:');
  const bot = new EventEmitter();
  Object.assign(bot, { username: 'builder', _client: { options: { host: 'test', port: 25565 } },
    game: { dimension: 'overworld' }, blockAt: () => null });
  const observer = attachSharedWorldObserver(bot, { store });
  try {
    assert.equal(attachSharedWorldObserver(bot, { store }), observer);
    bot.emit('blockUpdate', null, block(0, 64, 0, 'dirt'));
    bot.game.dimension = 'the_nether';
    bot.emit('blockUpdate', null, block(0, 64, 0, 'netherrack'));
    bot.emit('blockUpdate', null, null);
    bot.emit('end');
    assert.equal(bot.listenerCount('blockUpdate'), 0);
    assert.equal(store.getBlock(context.world, 'overworld', block(0, 64, 0).position).name, 'dirt');
    assert.equal(store.getBlock(context.world, 'the_nether', block(0, 64, 0).position).name, 'netherrack');
  } finally { observer.stop(); store.close(); }
});

test('heartbeat agent tidak mematikan worker saat sqlite terkunci sementara', () => {
  const store = new SharedWorldMemory(':memory:');
  const board = new SwarmTaskBoard(store);
  const context = { world: 'test:25565', dimension: 'overworld' };
  try {
    board.registerAgent({ id: 'miner', ...context, capabilities: ['mine'] });
    const originalPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => {
      if (String(sql).startsWith('UPDATE swarm_agents SET')) {
        return { run: () => {
          const error = new Error('database is locked');
          error.code = 'ERR_SQLITE_ERROR';
          throw error;
        } };
      }
      return originalPrepare(sql);
    };
    assert.equal(board.heartbeatAgent('miner', { ...context, status: 'STOPPED' }), false);
  } finally { store.close(); }
});

test('sampel semua worker juga menyimpan analisis semantik bersama', () => {
  const store=new SharedWorldMemory(':memory:');
  const bot=new EventEmitter();
  Object.assign(bot,{username:'farmer',_client:{options:{host:'test',port:25565}},game:{dimension:'overworld'},
    entity:{position:{x:0,y:64,z:0}},entities:{},
    blockAt:p=>({name:p.y===63?'farmland':p.y===64?'wheat':'air',position:p,boundingBox:p.y===63?'block':'empty'})});
  const observer=attachSharedWorldObserver(bot,{store});
  try {
    observer.sample();
    assert.equal(store.analyses().length,1);
    assert.ok(store.analyses()[0].hypotheses.some(h=>h.type==='crop_farm'));
  } finally {observer.stop();store.close();}
});

test('segmentasi memisahkan lantai dan bangunan terpisah', () => {
  const groups = connectedComponents([block(0, 64, 0), block(1, 64, 0), block(0, 70, 0), block(8, 64, 0)]);
  assert.deepEqual(groups.map(g => g.length), [2, 1, 1]);
  assert.deepEqual(boundsOf(groups[0]), { min: { x: 0, y: 64, z: 0 }, max: { x: 2, y: 65, z: 1 } });
});

test('LLM opsional tidak mengirim tools atau menggandakan /v1', async () => {
  assert.equal(createLandmarkLlmClient({}), null);
  let calls = 0;
  const client = createLandmarkLlmClient({ LANDMARK_LLM_ENABLED: 'true', LANDMARK_LLM_API_KEY: 'test-only',
    LANDMARK_LLM_MODEL: 'test-model', LANDMARK_LLM_BASE_URL: 'https://example.test/compatible-mode/v1/' }, async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.test/compatible-mode/v1/chat/completions');
    assert.equal(JSON.parse(options.body).tools, undefined);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Lahan Gandum' } }] }) };
  });
  assert.equal((await client.chat('farmland')).message, 'Lahan Gandum');
  assert.equal((await client.chat('farmland')).message, '');
  assert.equal(calls, 1);
});
