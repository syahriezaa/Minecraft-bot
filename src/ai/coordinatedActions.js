const { cell } = require('./swarmReservations');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

function installCoordinatedActions(bot, reservations, getContext, log = () => {}) {
  const originals = new Map();
  const handles = new Set();
  function cancel() {
    try {
      bot.pathfinder?.setGoal?.(null);
      bot.clearControlStates?.();
      bot.stopDigging?.();
    } catch { log('Aksi dihentikan karena reservasi tidak berlaku.'); }
  }
  function hold(positions, { shared = false } = {}) {
    const context = getContext();
    if (!context) throw new Error('Identitas dunia belum tersedia untuk reservasi');
    const resources = positions.map(position => {
      const encoded = cell(position);
      return shared ? `shared:${encoded}` : encoded;
    });
    const lease = reservations.acquire(context, resources);
    if (!lease) {
      const wait=reservations.recordWait(context,resources);
      if(wait.deadlock) cancel();
      throw new Error(wait.deadlock ? 'DEADLOCK_REPLAN: hentikan aksi dan pilih rute lain' : 'RESOURCE_RESERVED: target sedang digunakan bot lain');
    }
    let valid = true;
    const timer = setInterval(() => {
      try { if (!reservations.renew(lease)) { valid = false; cancel(); } }
      catch { valid = false; cancel(); }
    }, 5000);
    timer.unref?.();
    const handle = {
      check() { if (!valid || !reservations.renew(lease)) { cancel(); throw new Error('RESERVATION_EXPIRED'); } },
      release() { clearInterval(timer); reservations.release(lease); handles.delete(handle); }
    };
    handles.add(handle);
    return handle;
  }
  function wrap(name, positions, container = false) {
    if (typeof bot[name] !== 'function') return;
    const original = bot[name];
    originals.set(name, original);
    bot[name] = async function (...args) {
      const p = bot.entity?.position;
      const resources = positions(...args);
      if (p) resources.push(p, { x: p.x, y: Math.floor(p.y)+1, z: p.z });
      const handle = hold(resources, { shared: container });
      let retained = false;
      try {
        const result = await original.apply(this, args);
        handle.check();
        if (container && result?.close) {
          const close = result.close.bind(result);
          result.close = (...a) => { try { return close(...a); } finally { handle.release(); } };
          result.once?.('close', () => handle.release());
          retained = true;
        }
        return result;
      } finally { if (!retained) handle.release(); }
    };
  }
  wrap('dig', block => [block.position]);
  wrap('placeBlock', (reference, face) => [reference.position,
    { x: reference.position.x+face.x, y: reference.position.y+face.y, z: reference.position.z+face.z }]);
  const containerCells = block => {
    const positions = [block.position];
    // Pasangan double chest harus berbagi lock, termasuk ketika dibuka dari sisi berbeda.
    if (['chest', 'trapped_chest'].includes(block.name)) for (const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const p = new Vec3(block.position.x+x,block.position.y,block.position.z+z);
      if (bot.blockAt(p)?.name === block.name) positions.push(p);
    }
    return positions;
  };
  for (const name of ['openChest','openFurnace','openContainer']) wrap(name, containerCells, true);
  const pathfinder=bot.pathfinder;
  const originalGoto=pathfinder?.goto;
  if(originalGoto && pathfinder.getPathTo) pathfinder.goto=async goal=>{
    const movements=pathfinder.movements;
    const exclusions=movements?.exclusionAreasStep;
    if(!exclusions)throw new Error('COORDINATED_PATH_UNAVAILABLE');
      // A container visit may share the short approach corridor with another
      // worker, but its own container lock is still exclusive/shared-aware.
      // This is used only for local logistics access, not for mining or
      // construction routes.
      const blocked=pathfinder.allowSharedRoute ? new Set() : reservations.blockedCells(getContext());
    const occupied=b=>!b?.position||blocked.has(cell(b.position))?Infinity:0;
    exclusions.push(occupied);
    try {
      for(let segment=0;segment<64;segment++) {
        const plan=pathfinder.getPathFromTo
          ? pathfinder.getPathFromTo(movements,bot.entity.position,goal,{timeout:100,optimizePath:false}).next().value.result
          : pathfinder.getPathTo(movements,goal,100);
        const points=plan.path||[];
        if(!points.length) {
          if(plan.status==='success')return;
          throw new Error('NEEDS_SURVEY: rute belum ditemukan');
        }
        const terrainChanges = points.some(p => p.toBreak?.length || p.toPlace?.length);
        // Terrain mutation is allowed only when the caller explicitly enabled
        // Movements.canDig. The complete route volume is already held below,
        // so another bot cannot occupy or mutate the same navigation window.
        if (terrainChanges && movements.canDig !== true) throw new Error('NEEDS_TERRAIN_PLAN');
        const path=points.slice(0,8);
        const start=bot.entity.position;
        const maxDropDown = Math.max(1, Number(movements.maxDropDown) || 1);
        for (let i = 0; i < path.length; i++) {
          const previousY = i ? Math.floor(path[i - 1].y) : Math.floor(start.y);
          const deltaY = path[i].y - previousY;
          // Pathfinder validates a supported landing for downward drops. Match that configured
          // capability while keeping upward movement limited to one block per natural step.
          if (deltaY > 1 || deltaY < -maxDropDown) throw new Error('RETURN_PATH_UNVERIFIED');
        }
        const route=[{x:Math.floor(start.x),y:Math.floor(start.y),z:Math.floor(start.z)},...path];
        // Pathfinder memeriksa sel samping diagonal dan ruang kepala ketika melompat,
        // bukan hanya node kaki. Reservasikan volume gerak untuk jendela pendek ini.
        const positions=route.flatMap(p=>{
          const cells=[];
          for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=2;dy++)cells.push({x:p.x+dx,y:p.y+dy,z:p.z+dz});
          return cells;
        });
        const handle=hold(positions, { shared: pathfinder.allowSharedRoute === true });
        const allowed=new Set(positions.map(cell));
        const constrain=b=>b?.position&&allowed.has(cell(b.position))?0:Infinity;
        exclusions.push(constrain);
        try {
          const last=path.at(-1);
          const complete=plan.status==='success'&&path.length===points.length;
          const destination=complete?goal:new goals.GoalBlock(last.x,last.y,last.z);
          await originalGoto.call(pathfinder,destination);
          handle.check();
          const actual=bot.entity.position;
          if(typeof destination.isEnd==='function') {
            const feet=new Vec3(Math.floor(actual.x),Math.floor(actual.y),Math.floor(actual.z));
            const fractional=actual.y-Math.floor(actual.y);
            const supported=bot.blockAt?.(feet)?.boundingBox==='block'&&fractional>0.001;
            const horizontalDistance = Math.hypot(actual.x - last.x, actual.z - last.z);
            const adjacentLanding = bot.entity.onGround && horizontalDistance <= 1.5 &&
              Math.abs(Math.floor(actual.y) - last.y) <= 1;
            if(!destination.isEnd(feet)&&!(supported&&destination.isEnd(feet.offset(0,1,0)))&&!adjacentLanding) {
              throw new Error(`NAVIGATION_UNCONFIRMED ${JSON.stringify({actual:{x:actual.x,y:actual.y,z:actual.z},target:{x:last.x,y:last.y,z:last.z},onGround:bot.entity.onGround})}`);
            }
          }
          if(complete)return;
        } finally {exclusions.splice(exclusions.indexOf(constrain),1);handle.release();}
      }
      throw new Error('NEEDS_SURVEY: batas segmen tercapai');
    } finally {const i=exclusions.indexOf(occupied);if(i>=0)exclusions.splice(i,1);}
  };
  return {
    hold,
    async run(positions, action, options = {}) {
      const handle = hold(positions, { shared: options.shared === true });
      try { const result = await action(); handle.check(); return result; }
      finally { handle.release(); }
    },
    close() {
      for (const handle of [...handles]) handle.release();
      for (const [name, original] of originals) bot[name] = original;
      if(originalGoto)pathfinder.goto=originalGoto;
      log('Reservasi sesi bot dilepas.');
    }
  };
}

module.exports = { installCoordinatedActions };
