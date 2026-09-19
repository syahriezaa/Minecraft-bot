const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { SwarmReservations } = require('../../src/ai/swarmReservations');
const { installCoordinatedActions } = require('../../src/ai/coordinatedActions');
const context = { world:'test',dimension:'overworld' };
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

test('empat proses yang berebut satu resource hanya menghasilkan satu pemilik', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reservation-test-'));
  const file=path.join(dir,'world.sqlite');
  const memory=new SharedWorldMemory(file);
  new SwarmReservations(memory);
  try {
    const results=await Promise.allSettled([0,1,2,3].map(i=>new Promise((resolve,reject)=>{
      const code=`const {SharedWorldMemory}=require(${JSON.stringify(require.resolve('../../src/ai/sharedWorldMemory'))});
        const {SwarmReservations}=require(${JSON.stringify(require.resolve('../../src/ai/swarmReservations'))});
        const m=new SharedWorldMemory(${JSON.stringify(file)});const r=new SwarmReservations(m,'worker-${i}');
        console.log(Boolean(r.acquire({world:'test',dimension:'overworld'},['cell:0,0,0'])));m.close();`;
      const child=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe']});
      let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
      child.on('error',reject);child.on('exit',c=>c===0?resolve(out.trim()==='true'):reject(new Error(err)));
    })));
    for(const r of results)assert.equal(r.status,'fulfilled',r.reason?.message);
    assert.equal(results.filter(r=>r.value).length,1);
  } finally {memory.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('akuisisi atomik, expiry, world isolation, reentrancy dan fencing token', () => {
  const memory = new SharedWorldMemory(':memory:');
  let now = 100;
  const a = new SwarmReservations(memory,'a',()=>now), b = new SwarmReservations(memory,'b',()=>now);
  try {
    const first = a.acquire(context,['cell:1','cell:2'],1000);
    assert.ok(first);
    assert.equal(b.acquire(context,['cell:0','cell:2']),null);
    assert.ok(b.acquire(context,['cell:0']));
    const nested = a.acquire(context,['cell:1'],1000);
    a.release(first);
    assert.equal(b.acquire(context,['cell:1']),null);
    assert.ok(b.acquire({ ...context,dimension:'nether' },['cell:1']));
    now = 1200;
    assert.ok(b.acquire(context,['cell:1']));
    assert.equal(a.renew(nested),false);
    a.release(nested);
    assert.equal(a.acquire(context,['cell:1']),null);
    b.close();
    assert.ok(a.acquire(context,['cell:1']));
  } finally { a.close(); b.close(); memory.close(); }
});

test('dua bot tidak dapat memakai sel sama; lease dibersihkan saat error', async () => {
  const memory = new SharedWorldMemory(':memory:');
  const a = new SwarmReservations(memory,'a'), b = new SwarmReservations(memory,'b');
  let unblock;
  const botA = { dig: () => new Promise(resolve=>{unblock=resolve;}) };
  const botB = { dig: async()=>{throw new Error('dig gagal');} };
  const actionsA = installCoordinatedActions(botA,a,()=>context);
  const actionsB = installCoordinatedActions(botB,b,()=>context);
  const target = { position:{x:1,y:2,z:3} };
  try {
    const pending = botA.dig(target);
    await assert.rejects(botB.dig(target),/RESOURCE_RESERVED/);
    unblock(); await pending;
    await assert.rejects(botB.dig(target),/dig gagal/);
    assert.ok(a.acquire(context,['cell:1,2,3']));
  } finally { actionsA.close(); actionsB.close(); a.close();b.close();memory.close(); }
});

test('reservasi container bertahan sampai window ditutup', async () => {
  const memory = new SharedWorldMemory(':memory:');
  const a = new SwarmReservations(memory,'a'), b = new SwarmReservations(memory,'b'), c = new SwarmReservations(memory,'c');
  const bot = { openChest: async()=>({close(){}}) };
  const actions = installCoordinatedActions(bot,a,()=>context);
  try {
    const chest = await bot.openChest({ name:'barrel',position:{x:0,y:0,z:0} });
    // Dua worker boleh membuka container yang sama untuk mempercepat logistik,
    // tetapi worker ketiga tetap ditahan.
    const secondOpener = b.acquire(context,['shared:cell:0,0,0']);
    assert.ok(secondOpener);
    assert.equal(c.acquire(context,['shared:cell:0,0,0']),null);
    assert.equal(c.acquire(context,['cell:0,0,0']),null);
    chest.close();
    assert.equal(c.acquire(context,['cell:0,0,0']),null);
    b.release(secondOpener);
    assert.ok(b.acquire(context,['cell:0,0,0']));
  } finally { actions.close();a.close();b.close();c.close();memory.close(); }
});

test('bot idle menghalangi reservasi dan siklus saling menunggu terdeteksi',()=>{
  const memory=new SharedWorldMemory(':memory:');let now=100;
  const a=new SwarmReservations(memory,'a',()=>now),b=new SwarmReservations(memory,'b',()=>now);
  try {
    a.occupy(context,[{x:0,y:0,z:0}]);b.occupy(context,[{x:1,y:0,z:0}]);
    assert.equal(a.acquire(context,['cell:1,0,0']),null);
    assert.equal(a.recordWait(context,['cell:1,0,0']).deadlock,false);
    assert.equal(b.recordWait(context,['cell:0,0,0']).deadlock,true);
    now=6000;
    assert.ok(a.acquire(context,['cell:1,0,0']));
  }finally{a.close();b.close();memory.close();}
});

test('goto langsung mereservasi seluruh rute lalu melepas setelah tiba',async()=>{
  const memory=new SharedWorldMemory(':memory:');const a=new SwarmReservations(memory,'a'),b=new SwarmReservations(memory,'b');
  const bot={entity:{position:{x:0,y:64,z:0}},pathfinder:{movements:{exclusionAreasStep:[]},
    getPathTo:()=>({status:'success',path:[{x:1,y:64,z:0},{x:2,y:64,z:0}]}),
    goto:async()=>{assert.equal(b.acquire(context,['cell:1,64,0']),null);}}};
  const actions=installCoordinatedActions(bot,a,()=>context);
  try {
    await bot.pathfinder.goto({});
    assert.ok(b.acquire(context,['cell:1,64,0']));
    assert.equal(bot.pathfinder.movements.exclusionAreasStep.length,0);
  }finally{actions.close();a.close();b.close();memory.close();}
});

test('reservasi menggunakan node lengkap, bukan waypoint hasil optimisasi',async()=>{
  const memory=new SharedWorldMemory(':memory:');const a=new SwarmReservations(memory,'a'),b=new SwarmReservations(memory,'b');
  const bot={entity:{position:{x:0,y:64,z:0}},pathfinder:{movements:{exclusionAreasStep:[]},
    getPathTo:()=>{throw new Error('Jalur terkompresi tidak boleh digunakan');},
    getPathFromTo:function*(movements,start,goal,options){
      assert.equal(options.optimizePath,false);
      yield {result:{status:'success',path:[{x:1,y:64,z:0},{x:2,y:64,z:0},{x:3,y:64,z:0}]}};
    },
    goto:async()=>{
      assert.equal(b.acquire(context,['cell:2,64,0']),null);
      for(const filter of bot.pathfinder.movements.exclusionAreasStep) {
        assert.equal(filter({position:{x:2,y:65,z:0}}),0);
        assert.equal(filter({}),Infinity);
        assert.equal(filter(null),Infinity);
      }
    }}};
  const actions=installCoordinatedActions(bot,a,()=>context);
  try {await bot.pathfinder.goto({});}
  finally{actions.close();a.close();b.close();memory.close();}
});

test('validator accepts configured natural downward drops but rejects unsafe vertical jumps', async () => {
  const memory = new SharedWorldMemory(':memory:');
  const reservations = new SwarmReservations(memory, 'drop-test');
  const cases = [
    { path: [{ x: 1, y: 60, z: 0 }], maxDropDown: 4, ok: true },
    { path: [{ x: 1, y: 59, z: 0 }], maxDropDown: 4, ok: false },
    { path: [{ x: 1, y: 66, z: 0 }], maxDropDown: 4, ok: false }
  ];
  try {
    for (const scenario of cases) {
      const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, pathfinder: {
        movements: { exclusionAreasStep: [], maxDropDown: scenario.maxDropDown },
        getPathTo: () => ({ status: 'success', path: scenario.path }),
        goto: async () => {}
      }};
      const actions = installCoordinatedActions(bot, reservations, () => context);
      try {
        if (scenario.ok) await bot.pathfinder.goto({});
        else await assert.rejects(() => bot.pathfinder.goto({}), /RETURN_PATH_UNVERIFIED/);
      } finally { actions.close(); }
    }
  } finally { reservations.close(); memory.close(); }
});

test('terrain plan dapat dieksekusi bila role mengaktifkan canDig secara eksplisit', async () => {
  const memory = new SharedWorldMemory(':memory:');
  const reservations = new SwarmReservations(memory, 'terrain-test');
  const makeBot = canDig => ({
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      movements: { exclusionAreasStep: [], maxDropDown: 1, canDig },
      getPathTo: () => ({ status: 'success', path: [{ x: 1, y: 64, z: 0, toBreak: [{ name: 'dirt' }] }] }),
      goto: async () => {}
    }
  });
  try {
    const allowed = makeBot(true);
    const allowedActions = installCoordinatedActions(allowed, reservations, () => context);
    await allowed.pathfinder.goto({});
    allowedActions.close();

    const denied = makeBot(false);
    const deniedActions = installCoordinatedActions(denied, reservations, () => context);
    await assert.rejects(() => denied.pathfinder.goto({}), /NEEDS_TERRAIN_PLAN/);
    deniedActions.close();
  } finally { reservations.close(); memory.close(); }
});
