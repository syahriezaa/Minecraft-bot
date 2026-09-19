/**
 * @file mineflayerRoleAdapter.js
 * @description Adapter aksi Mineflayer untuk engine survival role.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { attachSharedWorldObserver } = require('./sharedWorldObserver');
const { LocalSpatialPlanner } = require('./localSpatialPlanner');

const FOOD_PRIORITY = Object.freeze([
  'golden_apple',
  'cooked_beef',
  'steak',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_salmon',
  'baked_potato',
  'bread',
  'apple',
  'carrot',
  'potato'
]);

const HOE_NAMES = Object.freeze([
  'wooden_hoe',
  'stone_hoe',
  'golden_hoe',
  'iron_hoe',
  'diamond_hoe',
  'netherite_hoe'
]);

function asVec3(pos) {
  if (!pos) return new Vec3(0, 0, 0);
  if (typeof pos.offset === 'function') return pos;
  return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}

class MineflayerRoleAdapter {
  constructor(bot, options = {}) {
    this.bot = bot;
    this.options = {
      defaultGoalRange: 1,
      // Batas waktu goto() pathfinder - ditemukan dari bug live nyata (StorageWorker berhenti
      // total, tidak ada tick/error sama sekali selama menit-menitan): bot.pathfinder.goto() ke
      // target yang TIDAK TERJANGKAU (mis. chest terkubur di tumpukan padat) tidak pernah resolve
      // maupun reject - satu target tak terjangkau membekukan SELURUH worker (semua tick berikutnya)
      // permanen, bukan cuma gagal aman untuk target itu saja.
      navigateTimeoutMs: 15000,
      // Jeda singkat sesudah windowOpen sebelum chest dianggap siap dipakai - ditemukan dari bug
      // live nyata: deposit gagal "destination full" padahal chest sungguhan (dicek langsung di
      // game) masih banyak slot kosong. windowOpen terpicu begitu paket open_window diterima,
      // TAPI isi slot sesungguhnya datang lewat paket window_items terpisah yang bisa saja belum
      // selesai diproses tepat saat itu (apalagi di server dengan lag yang sudah berulang kali
      // terlihat sepanjang sesi ini) - window.slots lokal bot bisa saja belum lengkap/akurat,
      // membuat pengecekan "ada slot kosong?" mineflayer keliru menyimpulkan chest penuh.
      chestSettleMs: 250,
      // Respons open_window yang hilang tidak boleh memegang lock logistik selamanya.
      containerOpenTimeoutMs: 12000,
      // Dipanggil dengan pesan Bahasa Indonesia tiap kali verifyChestContentsByRoundTrip benar-
      // benar melakukan probe ambil-taruh - supaya pemilik bisa MELIHAT LANGSUNG (lewat feed
      // dashboard) bahwa verifikasi ini sungguhan terjadi, bukan cuma lolos di tes unit.
      log: () => {},
      // Keep quarry survey cycles bounded so unreachable targets cannot monopolize a worker.
      reachableWorkCandidateLimit: 24,
      reachableWorkPathTimeoutMs: 30,
      reachableWorkMaxPages: 8,
      ...options
    };
    this.worldAwareness = options.worldAwareness || null;
    this.lastDigTool = null;
    // Semua aksi role pada satu bot berbagi satu pathfinder. Tanpa antrean,
    // pembukaan beberapa chest atau percobaan beberapa stance dapat mengganti
    // goal aktif satu sama lain dan meninggalkan worker tanpa bekal.
    this.navigationTail = Promise.resolve();
    this.activeNavigation = null;
    this.actionInterruptReason = null;
    this.taskProgressReporter = () => {};
    this.workProgressSequence = 0;
    this.spatialPlanner = new LocalSpatialPlanner(pos => typeof bot?.blockAt === 'function' ? bot.blockAt(asVec3(pos)) : null);
    this.sharedWorldObserver = options.sharedWorld === false ? null : attachSharedWorldObserver(bot, {
      store: options.sharedWorldStore,
      log: options.log || console.warn,
      coordinateMovement: options.coordinateMovement !== false,
      spatialSampling: options.spatialSampling !== false,
      occupancyIntervalMs: options.occupancyIntervalMs,
      flushIntervalMs: options.flushIntervalMs,
      agent: {
        id: options.agentId || bot?.username || 'worker',
        capabilities: options.capabilities || ['generic'],
        metadata: options.agentMetadata || {}
      }
    });
  }

  getPosition() {
    return this.bot?.entity?.position || { x: 0, y: 64, z: 0 };
  }

  cancelActiveActions(reason = 'INTERRUPTED') {
    this.actionInterruptReason = reason;
    this.activeNavigation?.cancel?.(reason);
    this.bot?.pathfinder?.setGoal?.(null);
    this.bot?.stopDigging?.();
    try { this.bot?.currentWindow?.close?.(); } catch {}
    this.bot?.clearControlStates?.();
  }

  clearActionInterrupt() { this.actionInterruptReason = null; }

  setTaskProgressReporter(reporter) {
    this.taskProgressReporter = typeof reporter === 'function' ? reporter : () => {};
  }

  reportTaskProgress(action, details = {}) {
    const observed = { action, ...details };
    if (['BLOCK_DUG', 'BLOCK_PLACED', 'SEED_PLANTED', 'ITEMS_WITHDRAWN', 'ITEMS_DEPOSITED'].includes(action)) {
      observed.progressSequence = ++this.workProgressSequence;
      // The parent watchdog must receive successful actions even without a global task lease.
      this.options.log?.(`WORK_EVENT ${JSON.stringify(observed)}`);
    }
    try { this.taskProgressReporter(observed); } catch {}
  }

  assertActionsAllowed(signal) {
    if (!signal?.aborted && !this.actionInterruptReason) return;
    const error = new Error(String(signal?.reason || this.actionInterruptReason || 'Aksi dibatalkan.'));
    error.name = 'AbortError';
    throw error;
  }

  getHealth() {
    return this.bot?.health ?? 20;
  }

  getFood() {
    return this.bot?.food ?? 20;
  }

  getEntities() {
    return Object.values(this.bot?.entities || {});
  }

  getInventoryItems() {
    if (typeof this.bot?.inventory?.items === 'function') return this.bot.inventory.items();
    if (Array.isArray(this.bot?.inventory?.items)) return this.bot.inventory.items;
    return [];
  }

  getItemByName(names) {
    const wanted = Array.isArray(names) ? names : [names];
    return this.getInventoryItems().find(item => wanted.includes(item.name)) || null;
  }

  getItemCount(name) {
    return this.getInventoryItems()
      .filter(item => item.name === name)
      .reduce((sum, item) => sum + (item.count || 1), 0);
  }

  hasItem(names) {
    return Boolean(this.getItemByName(names));
  }

  // Klaim kerja tingkat objek (mis. satu pohon penuh), bukan hanya satu blok
  // yang sedang dipukul. Tanpa ini dua worker dapat memilih pohon yang sama
  // dari snapshot dunia masing-masing lalu menghasilkan panen parsial.
  acquireSharedReservation(positions) {
    const hold = this.sharedWorldObserver?.actions?.hold;
    if (typeof hold !== 'function') return null;
    try { return hold(positions); }
    catch (error) {
      this.options.log(`[Reservasi] Objek kerja sedang dipakai worker lain: ${error.message}`);
      return null;
    }
  }

  async navigateNear(pos, range = this.options.defaultGoalRange, options = {}) {
    const previous = this.navigationTail;
    let release;
    this.navigationTail = new Promise(resolve => { release = resolve; });
    await previous.catch(() => false);
    try {
      const reached = await this._navigateNear(pos, range, options);
      if (reached) this.reportTaskProgress('NAVIGATED', { position: { x: pos.x, y: pos.y, z: pos.z } });
      return reached;
    } finally {
      release();
    }
  }

  async _navigateNear(pos, range = this.options.defaultGoalRange, options = {}) {
    this.assertActionsAllowed(options.signal);
    if (!pos) return false;
    if (this.activeNavigation && !this.activeNavigation.settled) {
      this.bot?.pathfinder?.setGoal?.(null);
      await Promise.race([
        this.activeNavigation.promise.then(() => {}, () => {}),
        new Promise(resolve => setTimeout(resolve, 250))
      ]);
      if (this.activeNavigation && !this.activeNavigation.settled) {
        if (!this.activeNavigation.warned) {
          this.activeNavigation.warned = true;
          this.options.log('[Navigasi] Rute sebelumnya belum selesai setelah pembatalan; target baru ditahan agar goal tidak saling menimpa.');
        }
        return false;
      }
    }
    let destination = pos;
    let destinationRange = range;
    let spatialPath = null;
    // Untuk interaksi lokal, pilih pijakan yang terhubung alih-alih menjadikan blok solid tujuan.
    if (this.bot?._client && !options.directPathfinder && !this.bot.pathfinder?.getPathTo && distance(this.getPosition(), pos) <= 12) {
      const survey = this.spatialPlanner.survey(this.getPosition());
      const stance = this.spatialPlanner.selectWorkPosition(survey, pos, range);
      if (stance) { destination = stance.position; destinationRange = 0; spatialPath = stance.path; }
      else if (survey.nodes.size && !survey.unknown && !survey.truncated) return false;
    }
    if (distance(this.getPosition(), pos) <= range) {
      this.bot?.pathfinder?.setGoal?.(null);
      return true;
    }
    if (this.bot?.pathfinder?.goto) {
      // Balapan goto() melawan batas waktu - lihat catatan navigateTimeoutMs di constructor.
      // Timeout SENGAJA resolve (bukan reject) ke false: caller (findMatchingChest,
      // withdrawAllFromChest, dst) sudah menganggap false/gagal sebagai sinyal "lewati saja,
      // lanjut ke target berikutnya", bukan error yang perlu ditangani khusus.
      const start = Date.now();
      const navigateTimeoutMs = Math.max(1, Number(options.timeoutMs) || this.options.navigateTimeoutMs);
      let timeoutHandle;
      let cancelled = false;
      let removeAbortListener = () => {};
      const timeout = new Promise((resolve) => {
          timeoutHandle = setTimeout(() => { cancelled = true; this.bot.pathfinder.setGoal?.(null); resolve(false); }, navigateTimeoutMs);
      });
      let result;
      let movePromise;
      const coordinator = this.sharedWorldObserver?.actions;
      const move = async () => {
        const pathfinder = this.bot.pathfinder;
        const previousSharedRoute = pathfinder.allowSharedRoute;
        if (options.sharedRoute === true) pathfinder.allowSharedRoute = true;
        const points = spatialPath || [destination];
        const resources = points.flatMap(p => [p, { ...p, y: p.y+1 }, { ...p, y: p.y-1 }]);
        const execute = async () => {
          const exclusions = this.bot.pathfinder.movements?.exclusionAreasStep;
          const allowed = new Set(resources.map(p => `${p.x},${p.y},${p.z}`));
          const routeOnly = block => allowed.has(`${block.position.x},${block.position.y},${block.position.z}`) ? 0 : Infinity;
          if (coordinator && spatialPath && exclusions) exclusions.push(routeOnly);
          try {
            for (const point of points) {
              if (cancelled || options.signal?.aborted) return false;
              const goal = options.goalXZOnly && !spatialPath && goals.GoalNearXZ
                ? new goals.GoalNearXZ(point.x, point.z, destinationRange)
                : new goals.GoalNear(point.x, point.y, point.z, spatialPath ? 0 : destinationRange);
              await this.bot.pathfinder.goto(goal);
            }
            return true;
          } finally {
            const index = exclusions?.indexOf(routeOnly) ?? -1;
            if (index >= 0) exclusions.splice(index, 1);
          }
        };
        try {
          return coordinator
            ? coordinator.run(resources, execute, { shared: options.sharedRoute === true })
            : execute();
        } finally {
          pathfinder.allowSharedRoute = previousSharedRoute;
        }
      };
      try {
        // Jangan meninggalkan goto lama berjalan saat caller langsung mencoba
        // kandidat berikutnya. Pathfinder akan memproses setGoal(null) secara
        // asynchronous; menunggu sebentar di sini mencegah dua goal saling
        // membatalkan dan menghasilkan "The goal was changed..." berantai.
        movePromise = Promise.resolve().then(move);
        const activeNavigation = {
          promise: movePromise, settled: false, warned: false,
          cancel: () => { cancelled = true; this.bot.pathfinder.setGoal?.(null); }
        };
        this.activeNavigation = activeNavigation;
        movePromise.then(() => {
          activeNavigation.settled = true;
          if (this.activeNavigation === activeNavigation) this.activeNavigation = null;
        }, () => {
          activeNavigation.settled = true;
          if (this.activeNavigation === activeNavigation) this.activeNavigation = null;
        });
        const interrupted = options.signal ? new Promise(resolve => {
          const onAbort = () => { cancelled = true; this.bot.pathfinder.setGoal?.(null); resolve(false); };
          if (options.signal.aborted) onAbort();
          else {
            options.signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => options.signal.removeEventListener('abort', onAbort);
          }
        }) : new Promise(() => {});
        result = await Promise.race([movePromise, timeout, interrupted]);
        if (cancelled) {
          await Promise.race([
            movePromise.catch(() => false),
            new Promise(resolve => setTimeout(resolve, 1000))
          ]);
        }
      } catch (error) {
        // Goal dapat berubah karena reconnect, timeout, atau aksi worker lain yang sedang
        // membersihkan pathfinder. Itu bukan alasan untuk mematikan seluruh worker; tandai
        // navigasi target ini gagal agar caller bisa mencoba target berikutnya.
        result = false;
        this.options.log(`[Navigasi] Target (${pos.x},${pos.y},${pos.z}) gagal: ${error.message} - dilewati.`);
      } finally {
        clearTimeout(timeoutHandle);
        removeAbortListener();
        if (!result) this.bot.pathfinder.setGoal?.(null);
      }
      this.assertActionsAllowed(options.signal);
      if (!result) {
        // Dulu gagal DIAM-DIAM tanpa jejak sama sekali - ditemukan dari keluhan nyata pemilik
        // ("kok bisa berjarak beberapa menit padahal harusnya kurang dari 5 detik") saat jeda
        // panjang tak terjelaskan antar pemeriksaan chest ternyata (diduga) navigasi yang macet
        // berulang kali, tapi tidak pernah tercatat di mana pun sehingga tidak kelihatan.
        this.options.log(`[Navigasi] PERINGATAN: navigasi ke (${pos.x},${pos.y},${pos.z}) timeout setelah ${Date.now() - start}ms (${navigateTimeoutMs}ms batas) - dilewati, lanjut ke target berikutnya.`);
      }
      return result;
    }
    return distance(this.getPosition(), pos) <= range;
  }

  selectReachableWork(targets, offset = 0) {
    if (this.bot.pathfinder?.getPathTo && this.bot.world?.raycast) {
      const started = Date.now();
      const candidateLimit = Math.max(4, Math.min(24, Number(this.options.reachableWorkCandidateLimit) || 24));
      const pathTimeout = Math.max(5, Math.min(30, Number(this.options.reachableWorkPathTimeoutMs) || 30));
      // Depth wins inside the local work window, not over distant inaccessible bottom layers.
      const candidates = [...targets].sort((a,b)=>distance(this.getPosition(),a.pos)-distance(this.getPosition(),b.pos)).slice(offset,offset+candidateLimit)
        .sort((a,b)=>(a.priority || 0)-(b.priority || 0)||distance(this.getPosition(),a.pos)-distance(this.getPosition(),b.pos));
      let partial = targets.length > offset + candidateLimit;
      let incomplete = false;
      for (const target of candidates) {
        if (Date.now()-started > 250) { partial = true; incomplete = true; break; }
        const goal = new goals.GoalLookAtBlock(asVec3(target.pos),this.bot.world,{reach:4.5});
        const result = this.bot.pathfinder.getPathFromTo
          ? this.bot.pathfinder.getPathFromTo(this.bot.pathfinder.movements,this.getPosition(),goal,{timeout:pathTimeout,optimizePath:false}).next().value.result
          : this.bot.pathfinder.getPathTo(this.bot.pathfinder.movements,goal,pathTimeout);
        if (result.status !== 'success') { if (result.status !== 'noPath') { partial=true; incomplete=true; } continue; }
        const route = [asVec3(this.getPosition()),...(result.path || [])];
        if (route.some((p, i) => i > 0 && Math.abs(p.y - Math.floor(route[i - 1].y)) > 1)) continue;
        if (route.some(p=>p.toBreak?.length||p.toPlace?.length||p.x===target.pos.x&&p.z===target.pos.z&&p.y-1===target.pos.y))continue;
        return {status:'REACHABLE',target,stance:{position:route.at(-1),path:route,score:route.length},survey:{nodes:new Map(),unknown:false,truncated:false}};
      }
      return {status:partial?'NEEDS_SURVEY':'NEEDS_ACCESS',incomplete,nextOffset:offset+candidateLimit,survey:{nodes:new Map(),unknown:partial,truncated:partial}};
    }
    return this.spatialPlanner.selectTarget(this.getPosition(), targets);
  }

  async approachReachableWork(targets, shouldStop = () => false) {
    let selection = this.selectReachableWork(targets);
    if (selection.nextOffset !== undefined) {
      let uncertain = selection.incomplete;
      const maxPages = Math.max(1, Math.min(8, Number(this.options.reachableWorkMaxPages) || 8));
      for (let page = 1; page < maxPages && !selection.target && selection.nextOffset < targets.length; page++) {
        if (shouldStop()) break;
        await new Promise(resolve => setImmediate(resolve));
        selection = this.selectReachableWork(targets, selection.nextOffset);
        uncertain ||= selection.incomplete;
      }
      if (!selection.target && uncertain) selection.status = 'NEEDS_SURVEY';
      return selection;
    }
    const nearest = p => targets.reduce((d, t) => Math.min(d, distance(p, t.pos)), Infinity);
    for (let attempt = 0; attempt < 3 && !selection.target && selection.status === 'NEEDS_SURVEY'; attempt++) {
      if (shouldStop()) break;
      const before = this.getPosition();
      let frontier = null;
      let bestDistance = nearest(before) - 1;
      for (const { position } of selection.survey.nodes.values()) {
        const d = nearest(position);
        if (d < bestDistance) { bestDistance = d; frontier = position; }
      }
      // Hanya berpindah di komponen yang memiliki jalur pulang, lalu baca dunia lagi.
      if (!frontier || !await this.navigateNear(frontier, 0)) break;
      if (distance(before, this.getPosition()) < 0.5) break;
      selection = this.selectReachableWork(targets);
    }
    return selection;
  }

  // Dekati target jarak dekat saat bertarung pakai GERAKAN LANGSUNG sederhana (lookAt + jalan
  // maju), BUKAN mineflayer-pathfinder A* sama sekali - permintaan nyata pemilik setelah TIGA
  // percobaan berbeda berbasis pathfinder (goto() statis, GoalFollow dinamis dengan blocking-wait,
  // GoalFollow dinamis non-blocking) SEMUA berakhir sama: server membeku (~100% CPU, seluruh
  // worker berhenti merespons menit-menitan) begitu bot berada di ruangan spawner sempit penuh
  // mob - tiap kena knockback, pathfinder menghitung ULANG rute A* dari posisi baru tanpa henti.
  // Pola gagal yang SAMA muncul di 3 pendekatan berbeda = tanda arsitekturnya yang salah untuk
  // ruang sempit padat mob (lihat skill systematic-debugging: "3+ fixes failed -> question
  // architecture"), bukan sekadar bug yang perlu ditambal lagi. Jalan LURUS sederhana TIDAK PERNAH
  // memicu pencarian A* - ruangan dungeon spawner kecil & relatif terbuka, tidak butuh navigasi
  // rumit menghindari rintangan untuk jarak dekat begini.
  async simpleApproach(entity, durationMs = 400) {
    if (!entity || typeof this.bot?.setControlState !== 'function') return false;
    await this.lookAt(entity.position);
    this.bot.setControlState('forward', true);
    this.bot.setControlState('sprint', true);
    this.bot.setControlState('jump', true);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    this.bot.setControlState('forward', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
    return true;
  }

  // Hentikan gerakan maju - dipanggil begitu target sudah dalam attackRange (siap diserang),
  // supaya bot tidak terus melangkah maju SAAT sedang menebas di tempat.
  stopApproaching() {
    if (typeof this.bot?.setControlState !== 'function') return;
    this.bot.setControlState('forward', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
  }

  async equipItem(names, destination = 'hand') {
    if (typeof this.bot?.equip !== 'function') return false;
    const itemName = this.getItemByName(names)?.name;
    if (!itemName) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const item = this.getItemByName(itemName);
      if (!item) return false;
      await this.bot.equip(item, destination);
      if (destination !== 'hand') return true;
      const deadline = Date.now() + 1500;
      while (Date.now() <= deadline) {
        if (this.bot.heldItem?.name === itemName) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    this.options.log(`[Inventaris] Gagal mengonfirmasi ${itemName} sudah berada di tangan; placement ditunda.`);
    return false;
  }

  async eatBestFood(foodNames = FOOD_PRIORITY) {
    const food = this.getItemByName(foodNames);
    if (!food || typeof this.bot?.equip !== 'function' || typeof this.bot?.consume !== 'function') return false;
    try {
      await this.bot.equip(food, 'hand');
      await this.bot.consume();
      return true;
    } catch (error) {
      // Server 775 kadang tidak mengonfirmasi consume sebelum timeout Mineflayer. Ini operasi
      // pemulihan, jadi jangan biarkan satu timeout makan mematikan seluruh worker; caller akan
      // memeriksa health/food dan memutuskan apakah perlu berhenti.
      this.options.log(`[Makanan] Gagal makan ${food.name}: ${error.message}`);
      return false;
    }
  }

  async lookAt(pos) {
    if (typeof this.bot?.lookAt === 'function') {
      await this.bot.lookAt(asVec3(pos));
      return true;
    }
    return false;
  }

  async equipBestToolForBlock(block) {
    const name = block?.name || '';
    const toolNames = name.includes('log') || name.includes('wood') || name.endsWith('_stem')
      ? ['iron_axe', 'diamond_axe', 'netherite_axe', 'stone_axe', 'wooden_axe']
      : ['dirt', 'grass', 'sand', 'gravel', 'clay', 'snow', 'mud'].some(part => name.includes(part)) ||
        ['coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt'].includes(name)
        ? ['iron_shovel', 'diamond_shovel', 'netherite_shovel', 'stone_shovel', 'wooden_shovel']
        : ['stone', 'cobblestone', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'ore'].some(part => name.includes(part))
          ? ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
          : [];
    for (const tool of toolNames) {
      if (this.getItemCount(tool) > 0 && await this.equipItem(tool, 'hand')) return tool;
    }
    return null;
  }

  async dig(block, { collectDrops = true, allowNavigation = true, signal } = {}) {
    this.assertActionsAllowed(signal);
    if (!block || typeof this.bot?.dig !== 'function') return false;
    const pos = block.position || block;
    const directFromStance = this.bot.canDigBlock?.(block) && this.bot.canSeeBlock?.(block);
    const isWoodLog = /(?:^|_)(?:log|wood|stem|hyphae)(?:$|_)/.test(block.name || '');
    const tool = await this.equipBestToolForBlock(block);
    if (tool !== this.lastDigTool) {
      this.options.log(tool ? `[Tool] ${tool} dipakai untuk menggali ${block.name}.` : `[Tool] Tidak ada tool cocok; ${block.name} digali dengan tangan.`);
      this.lastDigTool = tool;
    }
    // Tree drops fall to the base. Do not walk toward an upper trunk block
    // merely because collectDrops is enabled; that creates false access
    // failures after the first reachable log.
    const reachableFromStance = directFromStance || (collectDrops && isWoodLog && directFromStance);
    if (!reachableFromStance && (!allowNavigation || !await this.navigateNear(pos, 3, { signal }))) return false;
    this.assertActionsAllowed(signal);
    // Some protocol-775 item components expose malformed enchantment data. Mineflayer's
    // digTime expects an iterable here; preserve the normal calculation and fall back to the
    // same vanilla block calculation with no enchantment bonus when that component is invalid.
    const originalDigTime = this.bot.digTime;
    let patchedDigTime = false;
    if (typeof originalDigTime === 'function') {
      this.bot.digTime = target => {
        try { return originalDigTime(target); } catch (error) {
          if (!/enchantments is not iterable|know how to get the enchants/i.test(error.message)) throw error;
          const held = this.bot.heldItem;
          const eye = typeof this.bot._getBlockAtEyeLevel === 'function' ? this.bot._getBlockAtEyeLevel() : null;
          return target.digTime(held?.type ?? null, this.bot.game?.gameMode === 'creative',
            ['water', 'flowing_water'].includes(eye?.name), !this.bot.entity.onGround, [], this.bot.entity.effects || {});
        }
      };
      patchedDigTime = true;
    }
    try { await this.bot.dig(block); } finally {
      if (patchedDigTime) this.bot.digTime = originalDigTime;
    }
    this.reportTaskProgress('BLOCK_DUG', { block: block.name, position: { x: pos.x, y: pos.y, z: pos.z } });
    this.assertActionsAllowed(signal);
    // Barang hasil gali (mis. panen crop) jatuh sebagai item entity di tanah - jarak 3 blok cukup
    // untuk menggali tapi TIDAK cukup dekat untuk memicu pickup otomatis Minecraft. Mendekat sampai
    // benar-benar menginjak posisi blok (range 0) supaya barangnya ikut terambil, bukan ditinggalkan.
    if (collectDrops && !isWoodLog) await this.navigateNear(pos, 0, { signal });
    this.assertActionsAllowed(signal);
    return true;
  }

  async placeSeed(referenceBlock, seedName) {
    this.assertActionsAllowed();
    if (!referenceBlock || !seedName || typeof this.bot?.placeBlock !== 'function') return false;
    const equipped = await this.equipItem(seedName, 'hand');
    if (!equipped) return false;
    this.assertActionsAllowed();
    if (!await this.navigateNear(referenceBlock.position || referenceBlock, 3)) return false;
    this.assertActionsAllowed();
    await this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
    this.assertActionsAllowed();
    this.reportTaskProgress('SEED_PLANTED', { seed: seedName });
    return true;
  }

  // Cangkul dirt/grass jadi farmland - permintaan nyata pemilik: "farming bot harus bisa
  // memperbaiki tempat farming...bawa dirt dan hoe dari gudang". Cukup pegang cangkul lalu klik
  // kanan (activateBlock, PERSIS mekanisme yang sama dipakai setSpawnAtNearestBed untuk klik bed)
  // blok dirt/grass_block itu - Minecraft otomatis mengubahnya jadi farmland kalau ada ruang
  // kosong di atasnya, tidak perlu logika tambahan apapun.
  // Masukkan SATU item ke composter (klik kanan sekali = satu unit kompos) - permintaan nyata
  // pemilik: "aku baru menaruh komposer di gudang mungkin jika makanan terlalu banyak buat
  // kompser saja". Sengaja SATU unit per panggilan (bukan spam berkali-kali sekaligus) - composter
  // sungguhan cuma naik satu level per klik, dan kita tidak mau membanjiri satu composter dengan
  // seluruh isi tas dalam satu tick (biarkan FarmerEngine yang atur berapa kali panggil per tick).
  async feedComposter(pos, itemNames) {
    this.assertActionsAllowed();
    if (!pos || typeof this.bot?.activateBlock !== 'function') return false;
    const equipped = await this.equipItem(itemNames, 'hand');
    if (!equipped) return false;
    if (!await this.navigateNear(pos, 3)) return false;
    this.assertActionsAllowed();
    const block = this.blockAt(pos);
    if (!block) return false;
    await this.bot.activateBlock(block);
    this.assertActionsAllowed();
    return true;
  }

  async tillFarmland(pos) {
    this.assertActionsAllowed();
    if (!pos || typeof this.bot?.activateBlock !== 'function') return false;
    const equipped = await this.equipItem(HOE_NAMES, 'hand');
    if (!equipped) return false;
    if (!await this.navigateNear({ ...pos, y: pos.y + 1 }, 3)) return false;
    this.assertActionsAllowed();
    const block = this.blockAt(pos);
    if (!block) return false;
    await this.bot.activateBlock(block);
    this.assertActionsAllowed();
    return true;
  }

  async toggleDoor(pos) {
    this.assertActionsAllowed();
    if (!pos || typeof this.bot?.activateBlock !== 'function') return false;
    if (!await this.navigateNear(pos, 3)) return false;
    this.assertActionsAllowed();
    const block = this.blockAt(pos);
    if (!block || !String(block.name || '').endsWith('_door')) return false;
    await this.bot.activateBlock(block);
    this.assertActionsAllowed();
    return true;
  }

  // Isi lubang di lahan farming dengan dirt sebelum dicangkul - permintaan nyata pemilik: "bawa
  // dirt dan hoe dari gudang" untuk memperbaiki lahan. Ditaruh berdiri di atas blok solid TEPAT DI
  // BAWAH posisi lubang (sama seperti placeSeed menaruh benih di atas farmland) - kalau bawahnya
  // sendiri kosong (lubang lebih dari satu blok dalam), gagal dulu (false); tick berikutnya akan
  // coba isi level yang lebih rendah dulu (findRepairCandidates men-scan ulang tiap tick).
  async placeDirtAt(pos, itemName = 'dirt') {
    this.assertActionsAllowed();
    if (!pos || typeof this.bot?.placeBlock !== 'function') return false;
    const equipped = await this.equipItem(itemName, 'hand');
    if (!equipped) return false;
    // Tambal dari sisi tepi, tanpa menjadikan dasar lubang sebagai tujuan jalan.
    for (const off of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: 0 }]) {
      const ref = this.blockAt({ x: pos.x + off.x, y: pos.y + off.y, z: pos.z + off.z });
      if (!ref || ['air', 'water', 'lava', 'cave_air'].includes(ref.name) || ref.boundingBox === 'empty') continue;
      if (!await this.navigateNear({ x: pos.x + off.x, y: pos.y + 1, z: pos.z + off.z }, 3)) return false;
      this.assertActionsAllowed();
      await this.placeBlockAt(pos, ref, new Vec3(-off.x, -off.y, -off.z));
      this.assertActionsAllowed();
      return true;
    }
    return false;
  }

  async findReferences(pos) {
    if (!pos) return [];
    const offsets = [
      { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
      { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }
    ];
    const references = [];
    const negate = value => value === 0 ? 0 : -value;
    for (const offset of offsets) {
      const reference = this.blockAt({ x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z });
      if (!reference || ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(reference.name) || reference.boundingBox === 'empty') continue;
      references.push({ reference, face: new Vec3(negate(offset.x), negate(offset.y), negate(offset.z)) });
    }
    return references;
  }

  async findReference(pos) {
    return (await this.findReferences(pos))[0] || null;
  }

  async jumpBeforePlacement(pos) {
    const entityPos = this.bot?.entity?.position;
    if (!pos || !entityPos || typeof this.bot?.setControlState !== 'function') return false;
    const halfWidth = (this.bot.entity.width || 0.6) / 2;
    const sameColumn = entityPos.x + halfWidth > pos.x && entityPos.x - halfWidth < pos.x + 1 &&
      entityPos.z + halfWidth > pos.z && entityPos.z - halfWidth < pos.z + 1;
    const underFeet = sameColumn && entityPos.y < pos.y + 1 && entityPos.y + 0.2 >= pos.y;
    if (!underFeet) return false;
    this.bot.pathfinder?.setGoal?.(null);
    for (const control of ['forward', 'back', 'left', 'right', 'sprint', 'sneak']) this.bot.setControlState(control, false);
    this.bot.setControlState('jump', true);
    try {
      const deadline = Date.now() + (this.options.jumpTimeoutMs ?? 1200);
      while (Date.now() < deadline) {
        const currentY = this.bot.entity.position.y;
        if (currentY >= pos.y + 1.02) {
          this.options.log(`[Gerak] Kaki bebas target (${pos.x},${pos.y},${pos.z}), y=${currentY.toFixed(3)}; placement saat melompat.`);
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Lompatan belum membebaskan target (${pos.x},${pos.y},${pos.z}); kaki y=${this.bot.entity.position.y.toFixed(3)}`);
    } finally {
      this.bot.setControlState('jump', false);
    }
  }

  async placeBlockAt(pos, reference, face, { facing } = {}) {
    this.assertActionsAllowed();
    // Mengarahkan pandangan setelah melompat menghabiskan jendela placement di udara.
    if (typeof this.bot.lookAt === 'function') {
      await this.bot.lookAt(asVec3(reference.position).offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
    }
    this.assertActionsAllowed();
    if (facing) {
      const yaw = { north: Math.PI, south: 0, east: Math.PI / 2, west: -Math.PI / 2 }[facing];
      if (yaw === undefined || typeof this.bot.look !== 'function') throw new Error(`Unsupported placement facing: ${facing}`);
      await this.bot.look(yaw, this.bot.entity.pitch || 0, true);
      // force=true changes the local look immediately; a physics tick sends it to the server.
      if (typeof this.bot.waitForTicks === 'function') await this.bot.waitForTicks(1);
    }
    const previousSneak = this.bot.getControlState?.('sneak') || false;
    await this.jumpBeforePlacement(pos);
    this.assertActionsAllowed();
    const interactive = ['chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'hopper'].includes(reference.name);
    if (interactive && typeof this.bot.setControlState !== 'function') throw new Error('Sneak is required to place against a container.');
    if (interactive) this.bot.setControlState('sneak', true);
    try {
      if (typeof this.bot._placeBlockWithOptions === 'function') {
        await this.bot._placeBlockWithOptions(reference, face, { forceLook: 'ignore', swingArm: 'right' });
      } else {
        await this.bot.placeBlock(reference, face);
      }
      this.reportTaskProgress('BLOCK_PLACED', { position: { x: pos.x, y: pos.y, z: pos.z } });
    } finally {
      if (interactive) this.bot.setControlState('sneak', previousSneak);
    }
  }

  blockAt(pos) {
    if (this.worldAwareness && typeof this.worldAwareness.getBlockAt === 'function') {
      return this.worldAwareness.getBlockAt(pos.x, pos.y, pos.z);
    }
    if (typeof this.bot?.blockAt !== 'function') return null;
    const block = this.bot.blockAt(asVec3(pos));
    this.sharedWorldObserver?.observe(block);
    return block;
  }

  getSharedBlock(pos) {
    const context = require('./sharedWorldObserver').worldContext(this.bot);
    if (!context || !this.sharedWorldObserver) return null;
    return this.sharedWorldObserver.memory.getBlock(context.world, context.dimension, asVec3(pos));
  }

  isQuarryExpansionColumnSafe(pos, bounds, { rejectFalling = false } = {}) {
    const context = require('./sharedWorldObserver').worldContext(this.bot);
    const observer = this.sharedWorldObserver;
    const { minY, height } = this.bot.game || {};
    if (!context || !observer || !Number.isInteger(minY) || !Number.isInteger(height) || height <= 0) return false;
    const top = minY + height - 1;
    if (bounds.floorY < minY || bounds.maxY > top) return false;
    // Protect entire known structure footprints, including their empty interiors.
    const structure = observer.memory.db.prepare(`SELECT id FROM structure_voxels
      WHERE world=? AND dimension=? GROUP BY id
      HAVING MIN(x)<=? AND MAX(x)>=? AND MIN(z)<=? AND MAX(z)>=? LIMIT 1`)
      .get(context.world, context.dimension, pos.x + 2, pos.x - 2, pos.z + 2, pos.z - 2);
    if (structure) return false;
    for (const key of observer.reservations.blockedCells(context)) {
      if (!key.startsWith('cell:')) continue;
      const [x, , z] = key.slice(5).split(',').map(Number);
      if (Math.abs(x - pos.x) <= 2 && Math.abs(z - pos.z) <= 2) return false;
    }
    const { QUARRY_NAMES } = require('./storageRoomQuarry');
    const construction = new Set(['cobblestone', 'cobbled_deepslate', 'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch']);
    for (let x = pos.x - 2; x <= pos.x + 2; x++) {
      for (let z = pos.z - 2; z <= pos.z + 2; z++) {
        for (let y = bounds.floorY; y <= top; y++) {
          const block = this.bot.blockAt(new Vec3(x, y, z));
          if (!block || construction.has(block.name) || rejectFalling && ['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'].includes(block.name) ||
              !['air', 'cave_air', 'void_air'].includes(block.name) && !QUARRY_NAMES.has(block.name)) return false;
        }
      }
    }
    return true;
  }

  isQuarryOverheadSafe(pos) {
    // Reuse full-height structure/unknown/lease checks, with stricter falling-block protection.
    if (this.sharedWorldObserver) {
      return this.isQuarryExpansionColumnSafe(pos, { floorY: pos.y, maxY: pos.y }, { rejectFalling: true });
    }
    // Region-exclusive miners intentionally disable the shared observer to avoid
    // serializing separate quarry cells. They still need a local, conservative
    // overhead check so safe upward mining is not rejected as unknown forever.
    const { QUARRY_NAMES } = require('./storageRoomQuarry');
    const target = this.bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
    if (!target || !QUARRY_NAMES.has(target.name)) return false;
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const block = this.bot?.blockAt?.(new Vec3(pos.x + x, pos.y + y, pos.z + z));
      if (!block || ['water', 'lava', 'flowing_water', 'flowing_lava'].includes(block.name) ||
          ['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'].includes(block.name)) return false;
    }
    return true;
  }

  // Properti blockstate "type" chest ('left'/'right'/'single') - SATU-SATUNYA cara benar untuk
  // tahu apakah dua blok chest yang bersebelahan SUNGGUHAN pasangan double-chest fisik yang sama,
  // atau cuma kebetulan berdiri berdampingan tanpa benar-benar tersambung - ditemukan dari bug
  // live nyata (analisis mendalam pola dunia sungguhan): asumsi lama "dua chest bersebelahan pasti
  // satu wadah" TERNYATA SALAH - di gudang ini pasangan sungguhan selalu di sepanjang sumbu X
  // (chest 'right' di x=-181 berpasangan dengan chest 'left' di x=-180 pada z YANG SAMA), padahal
  // banyak chest 'right' lain juga kebetulan bersebelahan di sepanjang sumbu Z (mis. z=-353 dan
  // z=-352) TANPA benar-benar tersambung sebagai satu wadah - dua chest SAMA-SAMA 'right' (atau
  // sama-sama 'left') TIDAK PERNAH benar-benar berpasangan di Minecraft, cuma pasangan left+right
  // yang sungguhan. Chest tanpa pasangan (single) juga tidak pernah bergabung dengan apapun.
  getChestHalfType(pos) {
    const block = this.blockAt(pos);
    if (!block || block.name !== 'chest') return null;
    const props = typeof block.getProperties === 'function' ? block.getProperties() : block._properties;
    return props?.type || 'single';
  }

  findBlocksByNames(blockNames, options = {}) {
    if (this.worldAwareness && typeof this.worldAwareness.findBlocksByNames === 'function') {
      return this.worldAwareness.findBlocksByNames(blockNames, options);
    }
    if (typeof this.bot?.findBlocks !== 'function') return [];
    const names = new Set(blockNames);
    const matching = block => block && names.has(block.name);
    const positions = this.bot.findBlocks({
      matching,
      maxDistance: options.maxDistance || 32,
      count: options.count || 128,
      point: options.point ? asVec3(options.point) : undefined
    });
    return positions.map(pos => this.blockAt(pos)).filter(Boolean);
  }

  async useOn(entity) {
    this.assertActionsAllowed();
    if (!entity) return false;
    if (!await this.navigateNear(entity.position, 3)) return false;
    this.assertActionsAllowed();
    // Server ini (protokol 775, skema versi baru Mojang) mengubah bentuk paket use_entity: field
    // lama "mouse" (enum interact/attack/interact_at) DIHAPUS, diganti field "location" yang WAJIB
    // ada (bertipe lpVec3 - objek {x,y,z}, BUKAN opsional). bot.activateEntity() DAN
    // bot.activateEntityAt() bawaan mineflayer keduanya masih kirim skema LAMA (mouse+x/y/z terpisah,
    // tanpa field location sama sekali) - paket gagal serialisasi persis di field location yang
    // undefined ("Cannot read properties of undefined (reading 'x')"), dan kegagalan itu merusak
    // koneksi (semua tick berikutnya timeout sampai bot di-kick server) - bukan sekadar gagal aman.
    // Tulis paket LANGSUNG dengan skema yang benar untuk protokol ini, bypass fungsi bawaan
    // mineflayer yang belum diperbarui untuk versi Minecraft ini.
    if (this.bot?._client?.write) {
      await this.lookAt(entity.position);
      this.assertActionsAllowed();
      this.bot._client.write('use_entity', {
        target: entity.id,
        hand: 0, // main_hand
        location: { x: 0, y: 0, z: 0 },
        sneaking: false
      });
      return true;
    }
    if (typeof this.bot?.activateEntityAt === 'function') {
      await this.bot.activateEntityAt(entity, entity.position);
      this.assertActionsAllowed();
      return true;
    }
    if (typeof this.bot?.activateEntity === 'function') {
      await this.bot.activateEntity(entity);
      this.assertActionsAllowed();
      return true;
    }
    if (typeof this.bot?.useOn === 'function') {
      await this.bot.useOn(entity);
      this.assertActionsAllowed();
      return true;
    }
    return false;
  }

  async attack(entity) {
    this.assertActionsAllowed();
    if (!entity) return false;
    await this.lookAt(entity.position);
    this.assertActionsAllowed();
    // bot.attack() bawaan mineflayer masih memanggil useEntity() internal, yang menulis paket
    // use_entity skema LAMA (field "mouse", tanpa field "location" wajib) - crash yang sama persis
    // dengan bug useOn() yang sudah ditemukan sebelumnya, tapi lewat jalur berbeda (serangan, bukan
    // interact biasa) - merusak koneksi sampai bot ter-disconnect diam-diam. Server ini (protokol
    // 775) sebenarnya sudah punya paket "attack" terpisah khusus untuk serangan (cuma field
    // entityId) - tulis itu langsung, bypass bot.attack() yang belum diperbarui.
    if (this.bot?._client?.write) {
      this.bot._client.write('attack', { entityId: entity.id });
      if (typeof this.bot?.swingArm === 'function') this.bot.swingArm();
      return true;
    }
    if (typeof this.bot?.attack === 'function') {
      this.bot.attack(entity);
      return true;
    }
    return false;
  }

  activateShield() {
    if (typeof this.bot?.activateItem !== 'function') return false;
    this.bot.activateItem(true);
    return true;
  }

  deactivateShield() {
    if (typeof this.bot?.deactivateItem !== 'function') return false;
    this.bot.deactivateItem();
    return true;
  }

  async openChestAt(pos) {
    this.assertActionsAllowed();
    const block = this.blockAt(pos);
    if (!block || typeof this.bot?.openChest !== 'function') return null;
    let reachable = await this.navigateNear(pos, 3, { sharedRoute: true });
    if (!reachable) {
      // A chest row is a wall of solid blocks: GoalNear(container) can ask the
      // pathfinder to finish inside the row even though the container is
      // interactable from a neighbouring air block. Try a bounded set of safe
      // standing voxels around the container before declaring it inaccessible.
      const airNames = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'snow']);
      const liquidNames = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
      const current = this.getPosition();
      const candidates = [];
      for (const dy of [-1, 0, 1]) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const stance = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
          const feet = this.blockAt(stance);
          const head = this.blockAt({ ...stance, y: stance.y + 1 });
          const ground = this.blockAt({ ...stance, y: stance.y - 1 });
          if (!feet || !head || !ground || !airNames.has(feet.name) || !airNames.has(head.name) ||
            liquidNames.has(feet.name) || liquidNames.has(head.name) || ground.boundingBox !== 'block') continue;
          candidates.push(stance);
        }
      }
      candidates.sort((a, b) => Math.hypot(a.x - current.x, a.y - current.y, a.z - current.z) -
        Math.hypot(b.x - current.x, b.y - current.y, b.z - current.z));
      for (const stance of candidates.slice(0, 4)) {
        if (await this.navigateNear(stance, 1, { sharedRoute: true })) {
          reachable = true;
          this.options.log(`[Container] Pijakan alternatif ditemukan di (${stance.x},${stance.y},${stance.z}) untuk peti (${pos.x},${pos.y},${pos.z}).`);
          break;
        }
      }
    }
    this.assertActionsAllowed();
    if (!reachable) {
      this.options.log(`[Container] Navigasi gagal ke (${pos.x},${pos.y},${pos.z}); chest tidak dibuka.`);
      return null;
    }
    const openStart = Date.now();
    let chest;
    let timer;
    try {
      const pending = Promise.resolve().then(() => this.bot.openChest(block));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`window container timeout di (${pos.x},${pos.y},${pos.z})`)), this.options.containerOpenTimeoutMs);
      });
      chest = await Promise.race([pending, timeout]);
      this.assertActionsAllowed();
      clearTimeout(timer);
    } catch (error) {
      clearTimeout(timer);
      try { chest?.close?.(); } catch {}
      if (error?.name === 'AbortError') throw error;
      this.options.log(`[Container] Gagal membuka (${pos.x},${pos.y},${pos.z}): ${error.message}`);
      return null;
    }
    // Log EKSPLISIT buka/tutup - permintaan nyata pemilik: "coba tambahkan log bot membuka peti
    // dan bot menutup peti dan lihat di antara 2 log itu" - supaya waktu yang dihabiskan SELAMA
    // satu chest terbuka (settle-poll, probe verifikasi, withdraw/deposit) kelihatan jelas dan
    // terpisah dari waktu navigasi ke chest berikutnya (yang sudah dilaporkan lewat log navigasi).
    // Tag mengikuti jenis blok SUNGGUHAN (chest vs barrel) - permintaan nyata pemilik: "bot belum
    // bisa membedakan peti dan barel" - dulu SEMUA container dilaporkan sebagai "[Chest]" walau
    // yang dibuka sebenarnya barrel, jadi log saja tidak bisa dipakai untuk tahu jenis wadahnya.
    const tag = block.name === 'barrel' ? 'Barrel' : 'Chest';
    this.options.log(`[${tag}] Dibuka (${pos.x},${pos.y},${pos.z})`);
    try { await this.waitForStableChestItems(chest); }
    catch (error) {
      try { chest.close?.(); } catch {}
      throw error;
    }
    if (typeof chest?.close === 'function') {
      const originalClose = chest.close.bind(chest);
      chest.close = (...args) => {
        this.options.log(`[${tag}] Ditutup (${pos.x},${pos.y},${pos.z}) - ${Date.now() - openStart}ms sejak dibuka`);
        return originalClose(...args);
      };
    }
    return chest;
  }

  // Jangan percaya SATU jeda tunggal (chestSettleMs) lalu langsung anggap datanya sudah benar -
  // kalau lag server lebih lama dari jeda itu, satu bacaan sesudahnya bisa saja masih data lama/
  // belum lengkap. Baca ulang berkali-kali (dijeda chestSettleMs tiap kali) sampai dua bacaan
  // BERTURUT-TURUT benar-benar sama, baru anggap stabil - ditemukan dari keluhan nyata pemilik:
  // item salah tempat tetap tidak diambil karena data yang dicocokkan ke kategori seharusnya
  // belum ter-update saat chest baru saja dibuka.
  //
  // Batas berhenti menunggu dulu berupa JUMLAH percobaan tetap (4x) - ternyata masih bisa
  // menyerah terlalu dini kalau lag server panjang butuh lebih dari 4 kali baca sebelum stabil,
  // membuat bot "pergi" (lanjut ke aksi berikutnya) sambil masih membawa data yang basi -
  // ditemukan dari keluhan nyata pemilik: "bot nya membuka peti belum menerima data baru sudah
  // pergi...bot jangan boleh pergi sebelum menerima data baru". Sekarang batasnya WAKTU total
  // (chestSettleTimeoutMs, default 10 detik) - selama waktu itu belum habis, TERUS baca ulang
  // berapa kalipun perlu, tidak dibatasi jumlah percobaan tetap.
  async waitForStableChestItems(chest) {
    if (typeof chest?.containerItems !== 'function' || !(this.options.chestSettleMs > 0)) return;
    const timeoutMs = this.options.chestSettleTimeoutMs ?? 10000;
    const deadline = Date.now() + timeoutMs;
    const snapshot = (items) => items.map((it) => `${it.name}x${it.count}`).sort().join('|');
    let previous = snapshot(chest.containerItems());
    let attempts = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.options.chestSettleMs));
      this.assertActionsAllowed();
      attempts += 1;
      const current = snapshot(chest.containerItems());
      if (current === previous) return;
      previous = current;
    }
    // Batas WAKTU habis dan data MASIH terus berubah tiap dibaca - laporkan dengan jelas (dulu
    // ini gagal DIAM-DIAM, pemilik tidak percaya kejadiannya sungguhan sampai diminta bukti log
    // nyata) - dipakai adapter/engine yang memanggil ini sebagai sinyal bahwa bacaan berikutnya
    // masih mungkin belum benar-benar final.
    this.options.log(`[Verifikasi chest] PERINGATAN: data belum juga stabil setelah ${attempts}x baca ulang dalam ${timeoutMs}ms (lag server terlalu panjang) - lanjut pakai bacaan terakhir, mungkin belum benar-benar final.`);
  }

  // Cari chest di sekitar yang SUDAH berisi salah satu dari itemNames - dipakai FarmerEngine
  // (autoMatchStorage) supaya hasil panen ditaruh di gudang yang memang sudah terorganisir per
  // jenis item (mis. wheat dan carrot masing-masing punya chest sendiri), bukan ditumpuk ke satu
  // chest sembarangan. Membuka chest SATU-SATU (bukan paralel) - server Minecraft cuma izinkan satu
  // window terbuka per pemain dalam satu waktu.
  async findMatchingChest(itemNames, options = {}) {
    const excluded = new Set((options.excludePositions || []).map(pos => `${pos.x},${pos.y},${pos.z}`));
    const positions = typeof this.bot?.findBlocks === 'function'
      ? this.bot.findBlocks({
        matching: (b) => b && (b.name === 'chest' || b.name === 'barrel'),
        maxDistance: options.maxDistance || 24,
        count: options.count || 40
      })
      : [];
    for (const pos of positions) {
      if (excluded.has(`${pos.x},${pos.y},${pos.z}`)) continue;
      let chest;
      try {
        chest = await this.openChestAt(pos);
      } catch (error) {
        this.options.log(`[Restock] Peti (${pos.x},${pos.y},${pos.z}) gagal dibuka: ${error.message} - dilewati.`);
        continue;
      }
      if (!chest) continue;
      const items = typeof chest.containerItems === 'function' ? chest.containerItems() : [];
      if (typeof chest.close === 'function') chest.close();
      if (items.some((it) => itemNames.includes(it.name))) return pos;
    }
    return null;
  }

  // Daftar MENTAH semua posisi chest di sekitar, tanpa buka/filter isi apapun - dipakai
  // StorageManagerEngine untuk membedakan chest DI DALAM vs DI LUAR area rumah (murni geometri
  // posisi blok, jauh lebih cepat daripada findMatchingChest yang harus buka tiap chest satu-satu).
  // Cocokkan "chest" MAUPUN "barrel" - keduanya container penyimpanan biasa (bot.openChest bawaan
  // mineflayer sudah generik, mendukung kedua jenis blok ini) - permintaan nyata pemilik: barel di
  // antara chest gudang juga boleh dipakai untuk menyimpan, bukan cuma chest.
  findChestPositions(maxDistance = 32, count = 64) {
    if (typeof this.bot?.findBlocks !== 'function') return [];
    return this.bot.findBlocks({
      matching: (b) => b && (b.name === 'chest' || b.name === 'barrel'),
      maxDistance,
      count
    });
  }

  // Buka satu chest, baca isinya, tutup lagi - dipakai StorageManagerEngine untuk audit "buka
  // semua chest dan cek barang" saat merapikan gudang. Beda dari findMatchingChest (yang berhenti
  // di chest PERTAMA yang cocok) - ini baca isi SATU chest tertentu secara lengkap.
  //
  // { verify = true }: jalankan probe ambil-taruh (verifyChestContentsByRoundTrip) sebelum
  // membaca - PENTING untuk audit sungguhan (misplaced-item detection), tapi MAHAL (beberapa
  // ratus ms per chest). resolveChestForItem di storageManagerEngine.js juga memakai fungsi ini
  // untuk "mengintip" isi BANYAK chest sekaligus (cari yang sudah cocok/kosong) - kalau probe ikut
  // jalan di situ juga, mengintip 20+ chest jadi lambat sekali dan terlihat seperti macet -
  // ditemukan dari keluhan nyata pemilik: "worker nya membuka chest itu tapi sepertinya tidak
  // melihat isinya". Intipan seperti itu memakai verify:false - settle-poll pasif di openChestAt
  // saja sudah cukup untuk keputusan "sudah cocok / kosong / bukan", tidak butuh jaminan seketat
  // audit resmi.
  // { onRead }: dipanggil dengan isi chest SEBELUM chest.close() - permintaan nyata pemilik: "log
  // harus nya open -> get data -> save to memory -> close" - urutan ini memastikan data SUDAH
  // tersimpan ke memori/dashboard sebelum chest ditinggalkan, bukan ditutup duluan baru diproses
  // belakangan (yang sebelumnya membuat log "Ditutup" muncul SEBELUM log "Memori Gudang
  // diperbarui", padahal seharusnya sebaliknya).
  async getChestContents(pos, { verify = true, onRead } = {}) {
    const chest = await this.openChestAt(pos);
    if (!chest) return [];
    if (verify) await this.verifyChestContentsByRoundTrip(chest);
    const items = typeof chest.containerItems === 'function' ? chest.containerItems() : [];
    if (typeof onRead === 'function') await onRead(items);
    if (typeof chest.close === 'function') chest.close();
    return items;
  }

  // Menunggu pasif (waitForStableChestItems) saja belum cukup meyakinkan - dua bacaan yang sama-
  // sama masih basi/salah tetap akan dianggap "stabil". Cara yang lebih pasti: benar-benar AMBIL 1
  // biji item (transaksi nyata yang dikonfirmasi server), pastikan datanya berubah, lalu TARUH
  // KEMBALI persis sejumlah yang diambil dan tunggu konfirmasi itu juga - permintaan nyata pemilik:
  // "dia harus mengambil mengupdate dan pastikan isinya berubah lalu menaruh lagi lalu tunggu
  // hingga ter update". Cuma jalan kalau chest ada isinya (tidak ada yang perlu diverifikasi kalau
  // kosong) DAN inventaris bot masih longgar (>= chestVerifyReserveSlots, permintaan pemilik:
  // sisakan 2 slot) - supaya probe ini tidak pernah bikin inventaris kepenuhan.
  async verifyChestContentsByRoundTrip(chest) {
    if (typeof chest?.containerItems !== 'function') return;
    if (typeof chest?.withdraw !== 'function' || typeof chest?.deposit !== 'function') return;
    const items = chest.containerItems();
    if (items.length === 0) return;
    const reserve = this.options.chestVerifyReserveSlots ?? 2;
    if (this.getInventoryFreeSlotCount() < reserve) return;

    const probe = items[0];
    try {
      this.options.log(`[Verifikasi chest] Ambil 1x ${probe.name} sebagai probe untuk pastikan data sudah ter-update...`);
      await chest.withdraw(probe.type, probe.metadata ?? null, 1);
      await this.waitForStableChestItems(chest);
      await chest.deposit(probe.type, probe.metadata ?? null, 1);
      await this.waitForStableChestItems(chest);
      this.options.log(`[Verifikasi chest] ${probe.name} sudah ditaruh kembali - data chest ini sekarang dijamin ter-update.`);
    } catch (e) {
      this.options.log(`[Verifikasi chest] Probe ambil-taruh ${probe.name} gagal (${e.message}) - lanjut pakai bacaan settle-poll biasa.`);
    }
  }

  // Perkiraan jumlah slot kosong di inventaris utama bot (hotbar + inventory, di luar armor/
  // offhand/crafting) - dipakai verifyChestContentsByRoundTrip untuk memastikan probe ambil-taruh
  // tidak pernah dilakukan saat inventaris nyaris penuh.
  getInventoryFreeSlotCount() {
    const inv = this.bot?.inventory;
    if (!inv) return 0;
    if (typeof inv.emptySlotCount === 'function') return inv.emptySlotCount();
    const total = (Number.isFinite(inv.inventoryEnd) && Number.isFinite(inv.inventoryStart))
      ? inv.inventoryEnd - inv.inventoryStart
      : 36;
    return Math.max(0, total - this.getInventoryItems().length);
  }

  // Tarik SEMUA isi chest apapun jenisnya - dipakai StorageManagerEngine untuk "kumpulkan semua
  // chest di luar rumah" (beda dari withdrawFromChest yang butuh filter nama item spesifik, sengaja
  // dipakai FarmerEngine untuk ambil benih tertentu saja).
  async withdrawAllFromChest(pos) {
    const chest = await this.openChestAt(pos);
    if (!chest) return { itemsWithdrawn: 0, totalCount: 0 };
    let itemsWithdrawn = 0;
    let totalCount = 0;
    try {
      const items = chest.containerItems();
      for (const item of items) {
        this.assertActionsAllowed();
        if (typeof chest.withdraw !== 'function') continue;
        await chest.withdraw(item.type, item.metadata ?? null, item.count);
        itemsWithdrawn += 1;
        totalCount += item.count || 1;
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    return { itemsWithdrawn, totalCount };
  }

  // Slot armor mineflayer TETAP di indeks 5-8 (head/torso/legs/feet) di semua versi protokol
  // vanilla - bagian dunia yang jauh lebih stabil daripada field paket yang berubah-ubah (lihat
  // bug use_entity). Slot kosong berarti gear hilang/rusak TOTAL - di Minecraft, durabilitas habis
  // membuat item LENYAP dari slot, bukan cuma "rusak sebagian" - jadi ini sinyal paling andal untuk
  // "perlu diganti", tanpa perlu mem-parsing NBT durabilitas yang rawan berubah antar versi.
  getEquippedArmor() {
    const slots = this.bot?.inventory?.slots || [];
    return {
      head: slots[5]?.name || null,
      torso: slots[6]?.name || null,
      legs: slots[7]?.name || null,
      feet: slots[8]?.name || null
    };
  }

  // Ambil BEBERAPA jenis item sekaligus dari chest gudang dalam SATU kali buka-tutup - dipakai
  // StorageManagerEngine untuk menarik SEMUA item salah tempat di satu chest sekaligus. Beda dari
  // withdrawFromChest (yang buka-tutup chest SENDIRI-SENDIRI per jenis item) - ditemukan dari
  // keluhan nyata pemilik ("kok lama ya"): chest dengan banyak item salah tempat (mis. 8 jenis)
  // butuh 8 kali buka-tutup terpisah kalau dipanggil satu-satu, padahal semuanya bisa diambil
  // dalam SATU kunjungan yang sama - tiap buka-tutup butuh navigasi + jeda settle sendiri,
  // membuat pembersihan satu chest yang berantakan makan waktu jauh lebih lama dari perlu.
  async withdrawManyFromChest(pos, requests) {
    const chest = await this.openChestAt(pos);
    if (!chest) return requests.map((r) => ({ name: r.name, withdrawn: 0 }));
    const results = [];
    try {
      for (const { name, count } of requests) {
        this.assertActionsAllowed();
        const items = chest.containerItems();
        const match = items.find((it) => it.name === name);
        if (match && typeof chest.withdraw === 'function') {
          const take = Math.min(count, match.count);
          await chest.withdraw(match.type, match.metadata ?? null, take);
          results.push({ name, withdrawn: take });
        } else {
          results.push({ name, withdrawn: 0 });
        }
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    return results;
  }

  // Ambil item dari chest gudang ke inventaris - kebalikan dari depositToChest.
  async withdrawFromChest(pos, itemNames, count) {
    if (!(count > 0)) return { withdrawn: 0 };
    const chest = await this.openChestAt(pos);
    if (!chest) return { withdrawn: 0 };
    let withdrawn = 0;
    try {
      this.assertActionsAllowed();
      const items = chest.containerItems();
      const match = items.find((it) => itemNames.includes(it.name));
      if (match && typeof chest.withdraw === 'function') {
        const available = items.filter(item => item.type === match.type && item.metadata === match.metadata)
          .reduce((total, item) => total + item.count, 0);
        const take = Math.min(count, available);
        await chest.withdraw(match.type, match.metadata ?? null, take);
        withdrawn = take;
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    if (withdrawn > 0) this.reportTaskProgress('ITEMS_WITHDRAWN', { count: withdrawn });
    return { withdrawn };
  }

  // Cari crafting_table terdekat, ambil resep yang sungguh bisa dibuat sekarang (bahan cukup -
  // recipesFor cuma mengembalikan resep yang TERPENUHI), lalu craft. Gagal jelas (false) kalau
  // tidak ada meja atau bahan kurang, bukan crash - caller (GuardEngine) yang putuskan langkah
  // berikutnya (mis. ambil bahan dulu dari chest).
  async craftItem(itemName, count = 1) {
    this.assertActionsAllowed();
    // Resep 2x2 seperti stone_bricks tidak membutuhkan GUI crafting table. Memakai inventory
    // crafting menghindari windowOpen/updateSlot tambahan yang pada protokol 775 kadang terlambat.
    const itemId = this.bot?.registry?.itemsByName?.[itemName]?.id ?? itemName;
    if (this.bot?.inventory && typeof this.bot?.recipesFor === 'function') {
      const inventoryRecipes = this.bot.recipesFor(itemId, null, 1);
      if (inventoryRecipes.length > 0) {
        // Protocol 775 on this server can delay updateSlot:0 until the whole batch is processed.
        // One call per recipe type avoids paying the timeout once for every individual craft;
        // callers verify the resulting inventory delta before treating it as successful.
        await this.bot.craft(inventoryRecipes[0], count);
        this.assertActionsAllowed();
        return true;
      }
    }
    const tablePos = typeof this.bot?.findBlock === 'function'
      ? this.bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 16 })
      : null;
    if (!tablePos) return false;
    if (!await this.navigateNear(tablePos.position, 3)) return false;
    this.assertActionsAllowed();
    const tableBlock = this.blockAt(tablePos.position);
    // recipesFor butuh ID numerik item (via registry), bukan nama string.
    const recipes = typeof this.bot?.recipesFor === 'function' ? this.bot.recipesFor(itemId, null, 1, tableBlock) : [];
    if (!recipes || recipes.length === 0) return false;
    await this.bot.craft(recipes[0], count, tableBlock);
    this.assertActionsAllowed();
    return true;
  }

  // Klik bed terdekat untuk set titik spawn di sini - dipakai worker SEBELUM mulai kerja apapun,
  // supaya kalau proses direstart/logout, bot lanjut dari base pada login berikutnya (Minecraft
  // me-resume di posisi logout terakhir kalau tidak ada spawn point, tapi klik bed EKSPLISIT lebih
  // andal - tidak bergantung posisi logout persis yang mana). Gagal jelas (false) kalau tidak ada
  // bed dalam jangkauan, bukan macet menunggu.
  async setSpawnAtNearestBed(maxDistance = 16) {
    const bedBlock = typeof this.bot?.findBlock === 'function'
      ? this.bot.findBlock({ matching: (b) => b && b.name.endsWith('_bed'), maxDistance })
      : null;
    if (!bedBlock) return false;
    await this.navigateNear(bedBlock.position, 2);
    const block = this.blockAt(bedBlock.position);
    if (typeof this.bot?.activateBlock !== 'function') return false;
    await this.bot.activateBlock(block);
    // Beri jeda singkat - status isSleeping baru sungguh-sungguh terkonfirmasi lewat paket metadata
    // ASINKRON dari server (bukan langsung begitu paket klik kita TERKIRIM), jadi cek langsung
    // tanpa jeda berisiko race condition (belum sempat diperbarui saat dicek).
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Klik bed di sini SEMATA untuk set titik spawn - kalau kebetulan malam hari, server bisa
    // benar-benar menidurkan bot (bukan cuma set spawn), yang bisa membuatnya terjebak diam di
    // ranjang tanpa batas waktu kalau tidak dibangunkan. Tulis paket entity_action LANGSUNG dengan
    // actionId:0 ("leave_bed") - bot.wake() bawaan mineflayer masih kirim actionId:2, yang di
    // skema protokol server ini berarti "stop_sprinting", BUKAN "leave_bed" - bot tidak akan
    // pernah bangun lagi kalau pakai fungsi bawaan itu.
    if (this.bot.isSleeping && this.bot?._client?.write) {
      this.bot._client.write('entity_action', { entityId: this.bot.entity.id, actionId: 0, jumpBoost: 0 });
    }
    return true;
  }

  // maxPerItem (opsional): { namaItem: jumlahCadangan } - sisakan sejumlah itu di inventaris,
  // cuma setor SISA di atasnya. Dipakai FarmerEngine supaya benih (carrot/potato/wheat_seeds dst -
  // item yang sama dipakai baik sebagai hasil panen MAUPUN benih tanam) tidak habis disetor semua
  // ke gudang sebelum kebun benar-benar selesai ditanami - ditemukan dari permintaan nyata pemilik.
  async depositToChest(pos, predicate = () => true, maxPerItem = {}) {
    const chest = await this.openChestAt(pos);
    if (!chest) return { deposited: 0 };
    let deposited = 0;
    const depositedSoFar = new Map();
    try {
      for (const item of this.getInventoryItems()) {
        this.assertActionsAllowed();
        if (!predicate(item)) continue;
        const reserve = maxPerItem[item.name];
        let amount = item.count || 1;
        if (reserve !== undefined) {
          const already = depositedSoFar.get(item.name) || 0;
          // Anggap semua stack item ini sejauh ini (di stack-stack sebelumnya) sudah "dihitung"
          // menuju cadangan - sisakan cadangan dari stack PERTAMA yang cukup, setor penuh sisanya.
          const totalOfThisItem = this.getInventoryItems()
            .filter((i) => i.name === item.name)
            .reduce((s, i) => s + (i.count || 1), 0);
          const totalAllowedToDeposit = Math.max(0, totalOfThisItem - reserve);
          const remainingAllowance = Math.max(0, totalAllowedToDeposit - already);
          amount = Math.min(amount, remainingAllowance);
          if (amount <= 0) continue;
        }
        if (typeof chest.deposit === 'function') {
          // chest.deposit() sungguhan MELEMPAR "destination full" kalau chest genuinely tidak
          // muat lagi untuk jenis ini (bukan gagal dengan tenang) - dibungkus try/catch PER JENIS
          // ITEM supaya satu jenis yang kebetulan chest-nya penuh tidak menjatuhkan SELURUH proses
          // setor untuk jenis lain di kunjungan yang sama - ditemukan dari bug live nyata:
          // FarmerWorker.deposited tetap 0 selama bermenit-menit walau sudah panen 200+ item,
          // karena satu jenis crop yang chest-nya kebetulan penuh membuat setor GAGAL TOTAL untuk
          // semua jenis lain juga, inventaris tidak pernah mengempis - rantai akibatnya sampai ke
          // fitur lain: bot bahkan tidak pernah punya slot kosong untuk mengambil cangkul
          // perbaikan lahan.
          try {
            await chest.deposit(item.type, item.metadata ?? null, amount);
            deposited += amount;
            depositedSoFar.set(item.name, (depositedSoFar.get(item.name) || 0) + amount);
          } catch (e) {
            this.options.log(`[Deposit] PERINGATAN: gagal setor ${amount}x ${item.name} (${e.message}) - lewati, lanjut ke jenis lain.`);
          }
        }
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    if (deposited > 0) this.reportTaskProgress('ITEMS_DEPOSITED', { count: deposited });
    return { deposited };
  }
}

module.exports = {
  MineflayerRoleAdapter,
  FOOD_PRIORITY,
  HOE_NAMES,
  asVec3,
  distance
};
