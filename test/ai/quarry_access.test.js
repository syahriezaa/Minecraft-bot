const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planQuarryAccess, buildQuarryAccess } = require('../../src/ai/quarryAccess');
const { surveyStorageQuarry } = require('../../src/ai/storageRoomQuarry');
const bounds = { minX: -42, maxX: -35, minZ: -408, maxZ: -402, floorY: 40, maxY: 80 };
const key = p => `${p.x},${p.y},${p.z}`;

test('tangga berputar mencapai Y40 dan deepslate tanpa keluar footprint', () => {
  for (const floorY of [40, -32]) {
    const { steps, supports, corridorOnly, width } = planQuarryAccess({ ...bounds, floorY });
    assert.equal(corridorOnly, true);
    assert.equal(width, 1);
    assert.equal(steps.at(-1).y, floorY);
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i-1], b = steps[i];
      assert.equal(Math.abs(a.x-b.x)+Math.abs(a.z-b.z), 1);
      assert.equal(a.y-b.y, 1);
      assert.ok(b.x >= bounds.minX && b.x <= bounds.maxX && b.z >= bounds.minZ && b.z <= bounds.maxZ);
      assert.ok(b.x === bounds.minX || b.x === bounds.maxX || b.z === bounds.minZ || b.z === bounds.maxZ);
      for (const dy of [1,2,3]) assert.ok(!supports.has(key({ ...b, y: b.y+dy })));
    }
  }
});

function fixture(hollow = false) {
  const changed = new Map();
  const first = planQuarryAccess(bounds).steps[0];
  const bot = { health: 20, food: 20, entity: { position: { x: first.x+.5, y: first.y+1, z: first.z+.5 } } };
  const adapter = {
    blockAt: p => {
      const name = changed.get(key(p)) || (p.y <= 69 && (!hollow || p.x === first.x && p.z === first.z) ? 'stone' : 'air');
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
    getItemCount: () => 128,
    equipItem: async () => true,
    equipBestToolForBlock: async () => 'iron_pickaxe',
    dig: async b => { changed.set(key(b.position), 'air'); },
    navigateNear: async p => { bot.entity.position = { x: p.x+.5, y: p.y, z: p.z+.5 }; return true; }
  };
  bot.placeBlock = async (ref, face) => {
    changed.set(key({ x: ref.position.x+face.x, y: ref.position.y+face.y, z: ref.position.z+face.z }), 'cobblestone');
  };
  return { bot, adapter, changed, bounds, diggable: new Set(['stone']) };
}

test('membangun di medan utuh dan lubang dalam lalu menguji jalur pulang', async () => {
  for (const hollow of [false, true]) {
    const f = fixture(hollow);
    const result = await buildQuarryAccess(f);
    assert.equal(result.ready, true, result.reason);
    assert.ok(result.changed > 0);
    assert.equal(f.bot.entity.position.y, 70);
    const protectedCells = planQuarryAccess(bounds).supports;
    const survey = surveyStorageQuarry(f.adapter, bounds);
    assert.ok(survey.actions.every(a => !protectedCells.has(key(a.pos))));
  }
});

test('mengisi connector diagonal walau langkah berikutnya sudah berupa batu natural', async () => {
  const f = fixture();
  const plan = planQuarryAccess(bounds);
  const connector = { ...plan.steps[0], y: plan.steps[1].y };
  const originalBlockAt = f.adapter.blockAt;
  f.adapter.blockAt = position => key(position) === key(connector) && !f.changed.has(key(position))
    ? { name: 'air', position, boundingBox: 'empty' }
    : originalBlockAt(position);
  const result = await buildQuarryAccess(f);
  assert.equal(result.ready, true, result.reason);
  assert.equal(f.changed.get(key(connector)), 'cobblestone');
});

test('berhenti pada lava, kekurangan material, dan navigasi yang tidak memindahkan bot', async () => {
  const lava = fixture();
  lava.changed.set(key({ ...planQuarryAccess(bounds).steps[1], y: 69 }), 'lava');
  assert.equal((await buildQuarryAccess(lava)).ready, false);
  const empty = fixture(true);
  empty.adapter.getItemCount = () => 0;
  assert.equal((await buildQuarryAccess(empty)).reason, 'SUPPORT_UNCONFIRMED');
  const stuck = fixture();
  stuck.adapter.navigateNear = async () => true;
  assert.equal((await buildQuarryAccess(stuck)).reason, 'STEP_UNREACHABLE');
});

test('mengambil support dari batu natural lokal bila inventory support kosong', async () => {
  const f = fixture();
  let supports = 0;
  f.adapter.getItemCount = name => ['stone', 'cobblestone'].includes(name) ? supports : 0;
  const originalDig = f.adapter.dig;
  f.adapter.dig = async block => {
    await originalDig(block);
    if (block.name === 'stone') supports += 1;
    return true;
  };
  const result = await buildQuarryAccess(f);
  assert.equal(result.ready, true, result.reason);
  assert.ok(supports > 0, 'miner harus mengambil support dari blok natural lokal');
});

test('pijakan masuk dapat berasal dari teras aktual, bukan selalu Y69',()=>{
  const plan=planQuarryAccess(bounds,{x:bounds.maxX,z:bounds.maxZ,y:55});
  assert.deepEqual(plan.steps[0],{x:bounds.maxX,z:bounds.maxZ,y:55});
  assert.equal(plan.steps.at(-1).y,40);
});

test('arah reverse tetap berada di perimeter dan menghindari sisi spiral forward', () => {
  const entrance = { x: bounds.minX, z: bounds.maxZ, y: 55 };
  const plan = planQuarryAccess(bounds, entrance, 'reverse');
  assert.deepEqual(plan.steps[0], entrance);
  assert.ok(plan.steps.every(step => step.x === bounds.minX || step.x === bounds.maxX || step.z === bounds.minZ || step.z === bounds.maxZ));
  for (let i = 1; i < plan.steps.length; i += 1) {
    assert.equal(Math.abs(plan.steps[i - 1].x - plan.steps[i].x) + Math.abs(plan.steps[i - 1].z - plan.steps[i].z), 1);
    assert.equal(plan.steps[i - 1].y - plan.steps[i].y, 1);
  }
});

test('kebijakan akses tetap membatasi jatuh ke satu blok', async () => {
  const f = fixture();
  f.bot.pathfinder = { movements: { maxDropDown: 4 } };
  const result = await buildQuarryAccess({ ...f, maxDropDown: 1 });
  assert.equal(result.ready, true);
  assert.equal(f.bot.pathfinder.movements.maxDropDown, 1);
  assert.equal(result.corridorOnly, true);
});

test('validasi pijakan memakai radius sempit agar sukses dekat bukan false-success', async () => {
  const f = fixture();
  const ranges = [];
  const originalNavigateNear = f.adapter.navigateNear;
  f.adapter.navigateNear = async (pos, range) => {
    ranges.push(range);
    return originalNavigateNear(pos, range);
  };
  const result = await buildQuarryAccess(f);
  assert.equal(result.ready, true, result.reason);
  assert.ok(ranges.some(range => range === 0.75), `radius pijakan tidak ditemukan: ${ranges.join(',')}`);
});
