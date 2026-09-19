const { Vec3 } = require('vec3');
const key = p => `${p.x},${p.y},${p.z}`;
const air = b => b && ['air', 'cave_air', 'void_air'].includes(b.name);
const solid = b => b && b.boundingBox === 'block' && !['sand', 'gravel'].includes(b.name);

function planQuarryAccess(bounds, entranceY = 69, direction = 'forward') {
  if (bounds.maxX - bounds.minX < 2 || bounds.maxZ - bounds.minZ < 2) {
    throw new Error('Quarry terlalu sempit untuk tangga berputar');
  }
  const ring = [];
  for (let x = bounds.minX; x < bounds.maxX; x++) ring.push({ x, z: bounds.minZ });
  for (let z = bounds.minZ; z < bounds.maxZ; z++) ring.push({ x: bounds.maxX, z });
  for (let x = bounds.maxX; x > bounds.minX; x--) ring.push({ x, z: bounds.maxZ });
  for (let z = bounds.maxZ; z > bounds.minZ; z--) ring.push({ x: bounds.minX, z });
  const entrance = typeof entranceY === 'object' ? entranceY : { ...ring[0], y: entranceY };
  const offset = ring.findIndex(p=>p.x===entrance.x&&p.z===entrance.z);
  if(offset<0)throw new Error('Pijakan masuk harus berada pada perimeter izin kerja');
  const top = Math.max(bounds.floorY, entrance.y);
  const stepAt = i => ring[(offset + (direction === 'reverse' ? -i : i) + ring.length * 2) % ring.length];
  const steps = Array.from({ length: top - bounds.floorY + 1 }, (_, i) => ({ ...stepAt(i), y: top - i }));
  const supports = new Set(steps.map(key));
  for (let i = 1; i < steps.length; i++) supports.add(key({ ...steps[i - 1], y: steps[i].y }));
  return { steps, supports, corridorOnly: true, width: 1 };
}

function deriveLegacyQuarryAccessPath(bounds, supports, adapter) {
  const points = (Array.isArray(supports) ? supports : []).map(raw => {
    const [x, y, z] = String(raw).split(',').map(Number);
    return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) ? { x, y, z } : null;
  }).filter(p => p && p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ &&
    (p.x === bounds.minX || p.x === bounds.maxX || p.z === bounds.minZ || p.z === bounds.maxZ));
  const live = p => solid(adapter.blockAt(p));
  const byY = new Map();
  for (const point of points) if (live(point)) {
    if (!byY.has(point.y)) byY.set(point.y, []);
    byY.get(point.y).push(point);
  }
  const levels = [...byY.keys()].sort((a, b) => b - a);
  if (!levels.length || levels.at(-1) !== bounds.floorY) return null;
  const search = (index, path) => {
    if (index === levels.length - 1 && levels[index] === bounds.floorY) return path;
    const nextY = levels[index + 1];
    if (nextY !== levels[index] - 1) return null;
    for (const candidate of byY.get(nextY) || []) {
      const previous = path.at(-1);
      if (Math.abs(previous.x - candidate.x) + Math.abs(previous.z - candidate.z) !== 1) continue;
      const found = search(index + 1, [...path, candidate]);
      if (found) return found;
    }
    return null;
  };
  for (const first of byY.get(levels[0]) || []) {
    const found = search(0, [first]);
    if (found) return found;
  }
  return null;
}

async function buildQuarryAccess({ bot, adapter, bounds, diggable, existingPath = null, allowTerrainRecovery = false, maxDropDown = 1, approachMaxDropDown = 3, stepNavigationRange = 0.75, fillConfirmTimeoutMs = 2500, entranceAttempts = Number(process.env.STORAGE_QUARRY_ENTRANCE_ATTEMPTS) || 16, entranceSearchMaxMs = Number(process.env.STORAGE_QUARRY_ENTRANCE_SEARCH_MS) || 20000, shouldStop = () => false, log = () => {}, reservePlan = async()=>{} }) {
  // Akses boleh turun satu blok setiap langkah. Ini sengaja lebih ketat dari
  // navigasi biasa; kelonggaran hanya diberikan oleh pijakan tangga yang dibangun.
  const movement = bot?.pathfinder?.movements;
  const setDropPolicy = value => {
    if (movement) movement.maxDropDown = Math.max(1, Number(value) || 1);
  };
  setDropPolicy(approachMaxDropDown);
  // Radius besar cocok untuk mendekati area quarry, tetapi berbahaya untuk validasi
  // tangga: pathfinder bisa mengembalikan sukses ketika bot masih satu blok di atas
  // pijakan. Validasi anak tangga harus memaksa posisi kaki benar-benar dekat.
  const stepRange = Math.max(0, Math.min(2, Number(stepNavigationRange) || 0.75));
  const fillConfirmMs = Math.max(250, Math.min(10000, Number(fillConfirmTimeoutMs) || 2500));
  // Setelah bot berada di ring quarry, navigasi hanya perlu menemukan perpindahan
  // satu anak tangga. Membawa mode terrain/parkour dari perjalanan jauh ke sini
  // membuat A* membuka ruang pencarian besar dan dapat menghabiskan CPU saat target
  // sedang berubah. Penggalian tetap dilakukan eksplisit di bawah, bukan oleh A*.
  const stairPathfinder = bot?.pathfinder;
  const stairMovement = stairPathfinder?.movements;
  const previousStairSettings = stairMovement ? {
    canDig: stairMovement.canDig,
    allowParkour: stairMovement.allowParkour,
    allowSprinting: stairMovement.allowSprinting,
    allow1by1Towers: stairMovement.allow1by1Towers,
    allow1by1towers: stairMovement.allow1by1towers,
    maxDropDown: stairMovement.maxDropDown,
    thinkTimeout: stairPathfinder.thinkTimeout
  } : null;
  if (stairMovement) {
    stairMovement.canDig = false;
    // Kenaikan satu blok pada tangga membutuhkan lompatan pathfinder. Batas
    // jatuh tetap satu blok dan posisi akhir selalu diverifikasi oleh walkToStep,
    // jadi ini tidak membuka izin untuk melompati lubang quarry.
    stairMovement.allowParkour = true;
    stairMovement.allowSprinting = false;
    stairMovement.allow1by1Towers = false;
    stairMovement.allow1by1towers = false;
    stairMovement.maxDropDown = Math.max(1, Number(maxDropDown) || 1);
  }
  if (stairPathfinder) {
    const stepThinkTimeout = Math.max(1000, Number(process.env.STORAGE_QUARRY_STEP_THINK_TIMEOUT_MS) || 5000);
    stairPathfinder.thinkTimeout = Math.min(Number(previousStairSettings?.thinkTimeout) || stepThinkTimeout, stepThinkTimeout);
  }
  const navigateToEntrance = async p => {
    // Hanya recovery dari workspace yang sudah disurvei yang boleh membuka
    // jalur pendek. Blok non-natural tetap dilarang; setelah entrance ketemu,
    // walkToStep kembali memakai canDig=false untuk menjaga koridor tangga.
    const recoveryMovement = allowTerrainRecovery && stairMovement;
    const previousBreakRules = recoveryMovement && Array.isArray(stairMovement.exclusionAreasBreak)
      ? stairMovement.exclusionAreasBreak : [];
    if (recoveryMovement) {
      stairMovement.canDig = true;
      stairMovement.exclusionAreasBreak = [...previousBreakRules,
        block => diggable?.has(block?.name) ? 0 : 100];
      log('Recovery entrance: terrain work terbatas pada blok natural diaktifkan.');
    }
    try {
      return await adapter.navigateNear(p, 0);
    } finally {
      if (recoveryMovement) {
        stairMovement.canDig = false;
        stairMovement.exclusionAreasBreak = previousBreakRules;
      }
    }
  };
  const supportNames = new Set(['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block']);
  let verifiedPreviousStep = null;
  let verifiedStepCount = 0;
  const candidates=[];
  for(let x=bounds.minX;x<=bounds.maxX;x++)for(let z=bounds.minZ;z<=bounds.maxZ;z++) {
    if(x!==bounds.minX&&x!==bounds.maxX&&z!==bounds.minZ&&z!==bounds.maxZ)continue;
    for(let y=bounds.maxY-3;y>=bounds.floorY;y--) {
      const p={x,y,z};
      if(solid(adapter.blockAt(p))&&[1,2,3].every(dy=>air(adapter.blockAt({...p,y:y+dy}))))candidates.push(p);
    }
  }
  const at=bot.entity.position;
  // Akses harus dimulai dari permukaan/teras tertinggi yang dapat dicapai,
  // bukan dari pijakan terdekat di dasar lubang. Kalau kandidat tinggi gagal,
  // urutan berikutnya tetap mencoba teras yang lebih rendah secara bounded.
  const distanceFromBot = p => Math.hypot(p.x - at.x, p.y + 1 - at.y, p.z - at.z);
  candidates.sort((a, b) => allowTerrainRecovery
    ? distanceFromBot(a) - distanceFromBot(b) || b.y - a.y
    : b.y - a.y || distanceFromBot(a) - distanceFromBot(b));
  let entrance;
  // Kandidat terdekat sering berada di ujung tebing atau di samping lubang
  // lama. Pencarian entrance tetap bounded karena setiap percobaan dapat
  // menjalankan A* beberapa detik; retry berikutnya akan mencoba ulang dari
  // posisi dunia terbaru tanpa membakar CPU pada puluhan target buntu.
  const maxEntranceAttempts = Math.max(1, Math.min(16, Number(entranceAttempts) || 8));
  const entranceDeadline = Date.now() + Math.max(2000, Math.min(30000, Number(entranceSearchMaxMs) || 12000));
  let entranceProbeCount = 0;
  for(const p of candidates.slice(0, maxEntranceAttempts)) {
    if(shouldStop())break;
    if(Date.now() >= entranceDeadline)break;
    entranceProbeCount += 1;
    if(await navigateToEntrance({...p,y:p.y+1})){entrance=p;break;}
  }
  if(!entrance) {
    log(`QUARRY_ACCESS_ENTRANCE_SEARCH_FAIL attempts=${entranceProbeCount} candidates=${candidates.length} maxAttempts=${maxEntranceAttempts}`);
    return {ready:false,reason:'NO_REACHABLE_ENTRANCE',changed:0};
  }
  const plan = planQuarryAccess(bounds, entrance, allowTerrainRecovery ? 'reverse' : 'forward');
  setDropPolicy(maxDropDown);
  await reservePlan([...plan.supports]);
  let changed = 0;
  const fail = reason => ({ ready: false, reason, changed });
  async function walkToStep(p) {
    setDropPolicy(maxDropDown);
    if (!solid(adapter.blockAt(p))) return false;
    if (![1, 2].every(dy => air(adapter.blockAt({ ...p, y: p.y + dy })))) return false;
    const before = { ...bot.entity.position };
    const nudgeTowardStep = async () => {
      if (typeof bot.setControlState !== 'function' || typeof bot.lookAt !== 'function') return false;
      const startY = Number(bot.entity?.position?.y);
      // Kenaikan satu blok pada tangga membutuhkan jump eksplisit. Tanpa ini,
      // bot sering berhenti di bibir blok saat memvalidasi jalur pulang, lalu
      // seluruh frontier dianggap tidak aman walau pijakan dan konektornya ada.
      const needsJump = Number.isFinite(startY) && p.y + 1 > startY + 0.2;
      const deadline = Date.now() + 1200;
      try {
        await bot.lookAt(new Vec3(p.x + 0.5, p.y + 1, p.z + 0.5), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', needsJump);
        while (Date.now() < deadline) {
          const position = bot.entity?.position;
          if (position) {
            const horizontal = Math.hypot(position.x - p.x - 0.5, position.z - p.z - 0.5);
            if (Math.floor(position.y) === p.y + 1 && horizontal <= 1.25) return true;
            // A valid stair step drops one level. Falling more than that means
            // the server did not register the connector; stop immediately so
            // the bot cannot slide to the quarry floor while still moving.
            if (Number.isFinite(startY) && position.y < startY - 2.2) return false;
          }
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      } finally {
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        bot.setControlState('jump', false);
      }
      return true;
    };
    const current = bot.entity.position;
    const canNudge = typeof bot.setControlState === 'function' && typeof bot.lookAt === 'function';
    const adjacentToVerifiedStep = verifiedPreviousStep &&
      Math.abs(verifiedPreviousStep.x - p.x) + Math.abs(verifiedPreviousStep.z - p.z) === 1 &&
      Math.abs(verifiedPreviousStep.y - p.y) === 1;
    const localStep = canNudge && adjacentToVerifiedStep &&
      Math.hypot(current.x - p.x - 0.5, current.z - p.z - 0.5) <= 3.5 &&
      Math.abs(current.y - (p.y + 1)) <= 3.5;
    // Setelah langkah pertama, target selalu satu blok dari posisi terakhir. Dorongan
    // pendek menghindari A* berulang pada setiap tikungan; pathfinder tetap menjadi
    // fallback bila bot belum benar-benar berada di koridor akses.
    let reached = localStep ? await nudgeTowardStep() : await adapter.navigateNear({ ...p, y: p.y + 1 }, stepRange);
    if (!reached && !localStep) {
      // Pada sudut tangga diagonal, pathfinder kadang melihat perpindahan awal sebagai
      // drop dua blok walau target dan connector sudah solid. Izinkan retry navigasi
      // sedikit lebih longgar; validasi level pijakan di bawah tetap wajib lulus.
      setDropPolicy(Math.max(maxDropDown, 2));
      reached = await adapter.navigateNear({ ...p, y: p.y + 1 }, 0);
      setDropPolicy(maxDropDown);
    }
    if (!reached && !localStep && adjacentToVerifiedStep) {
      // Tikungan satu blok kadang membuat A* menolak transisi meski connector dan
      // target sudah solid. Dorongan pendek mengikuti geometri tangga yang terlihat,
      // lalu posisi tetap diverifikasi di bawah.
      reached = await nudgeTowardStep();
    }
    if (!reached) return false;
    let feet = bot.entity.position;
    let horizontalDistance = Math.hypot(feet.x - p.x - 0.5, feet.z - p.z - 0.5);
    let verticalDistance = Math.abs(feet.y - p.y - 1);
    // GoalNear(0.75) dapat berhenti di bibir blok ketika chunk sedang berubah.
    // Satu retry exact-range mencegah worker menganggap posisi satu tingkat di atas
    // sebagai pijakan valid lalu gagal pada langkah berikutnya.
    if (horizontalDistance > 1.25 || verticalDistance > 0.75) {
      if (!await adapter.navigateNear({ ...p, y: p.y + 1 }, 0)) return false;
      feet = bot.entity.position;
      horizontalDistance = Math.hypot(feet.x - p.x - 0.5, feet.z - p.z - 0.5);
      verticalDistance = Math.abs(feet.y - p.y - 1);
    }
    // Server dapat mengirim posisi pecahan tepat saat bot turun satu anak tangga.
    // Beri satu settle singkat, tetapi validasi akhir tetap memakai level blok agar
    // toleransi ini tidak menerima bot yang sungguh masih satu tingkat di atas.
    if (verticalDistance > 0.75 && verticalDistance <= 1.05) {
      await new Promise(resolve => setTimeout(resolve, 150));
      feet = bot.entity.position;
      horizontalDistance = Math.hypot(feet.x - p.x - 0.5, feet.z - p.z - 0.5);
      verticalDistance = Math.abs(feet.y - p.y - 1);
    }
    if (Math.floor(feet.y) !== p.y + 1 && await nudgeTowardStep()) {
      feet = bot.entity.position;
      horizontalDistance = Math.hypot(feet.x - p.x - 0.5, feet.z - p.z - 0.5);
      verticalDistance = Math.abs(feet.y - p.y - 1);
    }
    const moved = Math.hypot(feet.x - before.x, feet.y - before.y, feet.z - before.z) > 0.15;
    // Pathfinder dapat mengembalikan sukses ketika bot masih satu blok di atas target
    // (terutama setelah perubahan chunk/teleport). Posisi itu belum aman untuk melanjutkan
    // tangga karena langkah berikutnya akan terlihat seperti lompatan dua blok. Terima kondisi
    // "sudah di pijakan" hanya bila level kaki benar-benar sama dengan permukaan target.
    const expectedFeetLevel = p.y + 1;
    const onExpectedBlockLevel = Math.floor(feet.y) === expectedFeetLevel;
    const alreadyOnStep = horizontalDistance <= 1.1 && verticalDistance <= 0.35 && onExpectedBlockLevel;
    const valid = horizontalDistance <= 1.25 && verticalDistance <= 1.05 && onExpectedBlockLevel && (moved || alreadyOnStep);
    if (valid) {
      verifiedPreviousStep = { ...p };
      verifiedStepCount += 1;
    }
    return valid;
  }
  const inReach = p => {
    const a = bot.entity.position;
    return Math.hypot(a.x - p.x - 0.5, a.y + 1.62 - p.y - 0.5, a.z - p.z - 0.5) <= 4.5;
  };
  async function waitForSolid(p) {
    const deadline = Date.now() + fillConfirmMs;
    while (Date.now() <= deadline) {
      if (solid(adapter.blockAt(p))) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  async function mineLocalSupport() {
    if (supportNamesHasItem()) return true;
    const center = bot.entity.position;
    const protectedKeys = new Set(plan.supports);
    const candidates = [];
    for (let radius = 1; radius <= 2; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          for (let dy = -2; dy <= 2; dy += 1) {
            const p = { x: Math.floor(center.x) + dx, y: Math.floor(center.y) + dy, z: Math.floor(center.z) + dz };
            if (protectedKeys.has(key(p)) || !inReach(p)) continue;
            const block = adapter.blockAt(p);
            if (!solid(block) || !supportNames.has(block.name) || !diggable.has(block.name)) continue;
            if (p.x === Math.floor(center.x) && p.z === Math.floor(center.z) && p.y < Math.floor(center.y)) continue;
            candidates.push(block);
          }
        }
      }
      if (candidates.length) break;
    }
    for (const block of candidates) {
      const tool = await adapter.equipBestToolForBlock(block);
      if (!tool && !['dirt', 'grass_block'].includes(block.name)) continue;
      if (await adapter.dig(block, { collectDrops: true }) && supportNamesHasItem()) {
        log(`Support tangga diambil dari blok natural lokal (${key(block.position || block)}).`);
        return true;
      }
    }
    return false;
  }
  function supportNamesHasItem() {
    return [...supportNames].some(name => adapter.getItemCount(name) > 0);
  }
  async function fill(p) {
    const existing = adapter.blockAt(p);
    if (solid(existing)) return true;
    if (!air(existing) || !inReach(p)) return false;
    if (!supportNamesHasItem()) await mineLocalSupport();
    const material = [...supportNames].find(name => adapter.getItemCount(name) > 0);
    if (!material) {
      log(`QUARRY_ACCESS_FILL_FAIL reason=NO_SUPPORT_MATERIAL target=${key(p)} counts=${JSON.stringify({ cobblestone: adapter.getItemCount('cobblestone'), cobbled_deepslate: adapter.getItemCount('cobbled_deepslate'), stone: adapter.getItemCount('stone'), dirt: adapter.getItemCount('dirt'), grass_block: adapter.getItemCount('grass_block') })}`);
      return false;
    }
    if (!await adapter.equipItem(material, 'hand')) {
      log(`QUARRY_ACCESS_FILL_FAIL reason=EQUIP_SUPPORT_MATERIAL target=${key(p)} material=${material}`);
      return false;
    }
    let attempted = 0;
    for (const [x, y, z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const referencePosition = { x: p.x + x, y: p.y + y, z: p.z + z };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const liveTarget = adapter.blockAt(p);
        if (solid(liveTarget)) return true;
        if (!air(liveTarget)) break;
        if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 120));
        const ref = adapter.blockAt(referencePosition);
        if (!solid(ref)) break;
        attempted++;
        try {
          const face = new Vec3(-x, -y, -z);
          // Adapter produksi melakukan jump-before-placement saat target berada
          // di bawah kaki. Ini mencegah server menolak connector tangga karena
          // placement dikirim ketika bot masih menempati voxel target.
          if (typeof adapter.placeBlockAt === 'function') await adapter.placeBlockAt(p, ref, face);
          else await bot.placeBlock(ref, face);
        } catch (error) {
          log(`QUARRY_ACCESS_FILL_FAIL reason=PLACE_ERROR target=${key(p)} reference=${key(ref.position || ref)} attempt=${attempt} message=${error.message}`);
          continue;
        }
        if (!await waitForSolid(p)) {
          log(`QUARRY_ACCESS_FILL_FAIL reason=PLACEMENT_UNCONFIRMED target=${key(p)} reference=${key(ref.position || ref)} attempt=${attempt} timeoutMs=${fillConfirmMs}`);
          continue;
        }
        changed++;
        return true;
      }
    }
    log(`QUARRY_ACCESS_FILL_FAIL reason=${attempted ? 'NO_CONFIRMED_REFERENCE' : 'NO_REACHABLE_REFERENCE'} target=${key(p)} material=${material} posisi=${JSON.stringify(bot.entity.position)}`);
    return false;
  }
  const first = plan.steps[0];
  if (Array.isArray(existingPath) && existingPath.length > 1) {
    const position = bot.entity.position;
    const distanceTo = p => Math.hypot(position.x - p.x - 0.5, position.y - p.y - 1, position.z - p.z - 0.5);
    const nearestIndex = existingPath.reduce((best, p, index) => distanceTo(p) < distanceTo(existingPath[best]) ? index : best, 0);
    log(`Validasi akses lama mulai dari pijakan terdekat index=${nearestIndex}/${existingPath.length - 1} step=${key(existingPath[nearestIndex])}`);
    if (shouldStop() || !await walkToStep(existingPath[nearestIndex])) return fail('EXISTING_PATH_UNREACHABLE');
    for (let index = nearestIndex + 1; index < existingPath.length; index++) {
      if (shouldStop() || !await walkToStep(existingPath[index])) return fail('EXISTING_PATH_UNREACHABLE');
    }
    for (let index = existingPath.length - 2; index >= 0; index--) {
      if (shouldStop() || !await walkToStep(existingPath[index])) return fail('EXISTING_RETURN_UNREACHABLE');
    }
    for (let index = 1; index <= nearestIndex; index++) {
      if (shouldStop() || !await walkToStep(existingPath[index])) return fail('EXISTING_PATH_UNREACHABLE');
    }
    const existingFirst = existingPath[0];
    return { ready: true, changed: 0, steps: existingPath.length, accessPath: existingPath,
      entrance: existingFirst, corridorOnly: true, width: 1, reused: true };
  }
  if (!solid(adapter.blockAt(first))) return fail('ENTRANCE_SUPPORT_MISSING');
  let firstReached = false;
  const recoveryMovement = allowTerrainRecovery && stairMovement;
  const previousRecoveryBreakRules = recoveryMovement && Array.isArray(stairMovement.exclusionAreasBreak)
    ? stairMovement.exclusionAreasBreak : [];
  if (recoveryMovement) {
    // Hanya langkah pertama boleh membuka blok natural untuk menyambungkan
    // posisi bot ke entrance frontier. Setelah bot berada di pijakan, aturan
    // tangga kembali canDig=false dan seluruh koridor diverifikasi voxel demi voxel.
    stairMovement.canDig = true;
    stairMovement.exclusionAreasBreak = [...previousRecoveryBreakRules,
      block => diggable?.has(block?.name) ? 0 : 100];
  }
  try {
    firstReached = await walkToStep(first);
  } finally {
    if (recoveryMovement) {
      stairMovement.canDig = false;
      stairMovement.exclusionAreasBreak = previousRecoveryBreakRules;
    }
  }
  if (!firstReached) {
    log(`QUARRY_ACCESS_FAIL reason=ENTRANCE_UNREACHABLE step=${key(first)} posisi=${JSON.stringify(bot.entity.position)}`);
    return fail('ENTRANCE_UNREACHABLE');
  }
  for (let i = 1; i < plan.steps.length; i++) {
    if (shouldStop() || (bot.health ?? 20) < 15 || (bot.food ?? 20) < 10) return fail('SURVIVAL_OR_TIME_LIMIT');
    const p = plan.steps[i];
    // Tiga blok ruang bebas diperlukan saat berpindah dari anak tangga di atasnya.
    for (let dy = 3; dy >= 1; dy--) {
      const target = { ...p, y: p.y + dy };
      const b = adapter.blockAt(target);
      if (air(b)) continue;
      if (!b || !diggable.has(b.name) || !inReach(target)) return fail('UNSAFE_CLEARANCE');
      const feet = bot.entity.position;
      if (Math.floor(feet.x) === target.x && Math.floor(feet.z) === target.z && target.y < feet.y) return fail('UNDERFOOT');
      for (const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1]]) {
        const n = adapter.blockAt({ x: target.x+x, y: target.y+y, z: target.z+z });
        if (!n || ['water','lava','sand','gravel'].includes(n.name)) return fail('HAZARD_OR_UNKNOWN');
      }
      const tool = await adapter.equipBestToolForBlock(b);
      if (!tool && !['dirt','grass_block'].includes(b.name)) return fail('MISSING_TOOL');
      await adapter.dig(b, { collectDrops: false });
      if (!air(adapter.blockAt(target))) return fail('DIG_UNCONFIRMED');
      changed++;
    }
    // Connector tetap wajib ada walaupun blok target sudah natural-solid. Tanpa
    // ini, permukaan batu yang kebetulan sudah ada dapat menyembunyikan lubang
    // diagonal di antara dua pijakan dan navigator mengira ada drop dua blok.
    const connector = { ...plan.steps[i-1], y: p.y };
    if (!solid(adapter.blockAt(connector)) && !await fill(connector)) return fail('SUPPORT_UNCONFIRMED');
    if (!solid(adapter.blockAt(p)) && !await fill(p)) return fail('SUPPORT_UNCONFIRMED');
    if (!await walkToStep(p)) {
      log(`QUARRY_ACCESS_FAIL reason=STEP_UNREACHABLE step=${key(p)} index=${i} posisi=${JSON.stringify(bot.entity.position)}`);
      return fail('STEP_UNREACHABLE');
    }
    log(`QUARRY_ACCESS ${i}/${plan.steps.length-1} pijakan=${key(p)}`);
  }
  const staticPathIsSafe = () => {
    const position = bot.entity?.position;
    const nearPath = position && plan.steps.some(step =>
      Math.hypot(position.x - step.x - 0.5, position.y - step.y - 1, position.z - step.z - 0.5) <= 4.5);
    if (!nearPath || verifiedStepCount < 3) return false;
    return plan.steps.every((step, index) => {
      const block = adapter.blockAt(step);
      if (!solid(block) || ![1, 2].every(dy => air(adapter.blockAt({ ...step, y: step.y + dy })))) return false;
      if (index === 0) return true;
      const previous = plan.steps[index - 1];
      return Math.abs(previous.x - step.x) + Math.abs(previous.z - step.z) === 1 && previous.y - step.y === 1;
    });
  };
  // Uji jalur pulang juga sebelum mengizinkan penggalian produksi.
  for (const p of [...plan.steps].reverse()) {
    if (shouldStop()) return fail('TIME_LIMIT');
    if (!await walkToStep(p)) {
      // Di tikungan, pathfinder kadang kehilangan satu node walau bot sudah
      // berada di koridor dan geometri tangga sepenuhnya valid. Terima hanya
      // bukti statis yang ketat; followQuarryAccessPath akan menguji ulang
      // setiap pijakan sebelum worker meninggalkan quarry.
      if (staticPathIsSafe()) {
        log(`QUARRY_ACCESS_RETURN_STATIC_VERIFY steps=${plan.steps.length} verified=${verifiedStepCount}`);
        return { ready: true, changed, steps: plan.steps.length, accessPath: plan.steps,
          entrance: plan.steps[0], corridorOnly: plan.corridorOnly, width: plan.width,
          returnVerification: 'STATIC_GEOMETRY' };
      }
      log(`QUARRY_ACCESS_FAIL reason=RETURN_UNREACHABLE step=${key(p)} posisi=${JSON.stringify(bot.entity.position)}`);
      return fail('RETURN_UNREACHABLE');
    }
  }
  return { ready: true, changed, steps: plan.steps.length, accessPath: plan.steps,
    entrance: plan.steps[0], corridorOnly: plan.corridorOnly, width: plan.width };
}

module.exports = { planQuarryAccess, deriveLegacyQuarryAccessPath, buildQuarryAccess };
