/**
 * @file runWalkToBaseBot.js
 * @description Navigasi fisika-nyata (bukan teleport) dari titik spawn ke koordinat base, memakai
 * seluruh tumpukan navigasi proyek ini: physicsController (virtual keyboard di atas prismarine-physics),
 * pathfinder (A* flood-fill dengan biaya lompat/turun realistis), richVoxelSpatialEngine (validasi
 * blok & escape search), chunkConnectivityGraph (peta persisten per-kolom, tidak dibuang tiap siklus),
 * dan strategicRoute (rantai waypoint jangka panjang). Bisa dipakai standalone (CLI) atau dipanggil
 * dari webServer.js dengan callback onDecision untuk streaming keputusan tiap tick ke dashboard.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { LiveProtocolClient } = require('../network/liveProtocolClient');
const { RichVoxelSpatialEngine } = require('./richVoxelSpatialEngine');
const { findPath, findGroundY } = require('./pathfinder');
const { createPhysicsController, TICK_MS } = require('./physicsController');
const { buildWaypointChain, advanceWaypoint, distanceToLine, closestPointOnLine } = require('./strategicRoute');
const { createConnectivityGraph } = require('./chunkConnectivityGraph');
const { createRewardMap } = require('./rewardMap');

const DEFAULT_CREEPER_DANGER_RADIUS = 6;
const DEFAULT_HOSTILE_DANGER_RADIUS = 3;
const PATH_RECOMPUTE_INTERVAL_MS = 8000; // dipertahankan sebagai konstanta lama, dipakai tempat lain (escape) yang sengaja recompute segera
const PATH_RECOMPUTE_SAFETY_INTERVAL_MS = 30000; // jaring pengaman jarang - recompute utama sekarang dipicu perubahan graf, bukan timer
const CATASTROPHIC_FALL_THRESHOLD = 40;
const STALL_TIMEOUT_MS = 6000;
const IMPROVEMENT_EPSILON = 1.0;
const ESCAPE_BLACKLIST_RADIUS = 3;
const ESCAPE_BLACKLIST_COOLDOWN_MS = 6000;
const WIDE_RING_RADII = [2, 4, 6, 8, 12, 16, 24];
const BLOCKED_TICKS_BEFORE_ESCAPE_SEARCH = 15;
const WALL_FOLLOW_BIAS_ANGLE = Math.PI / 3;
const WALL_FOLLOW_RESET_MS = 25000;
const WAYPOINT_SPACING = 24;
const WAYPOINT_REACH_RADIUS = 6;
const MAX_DESCENT_BUDGET = 8;
// Batas seberapa jauh bot boleh menyimpang tegak lurus dari garis lurus utama (spawn->base) sebelum
// navigasi diprioritaskan untuk KEMBALI ke garis dulu, bukan terus mengejar goal akhir apa adanya -
// wall-follow/escape/frontier-push sebelumnya tidak punya "gaya tarik" balik ke rute ideal sama
// sekali, jadi bisa menyimpang sangat jauh ke samping/mundur tanpa batas selama menghindari rintangan.
const MAX_LINE_DEVIATION = 20;
const RETURN_TO_LINE_LOOKAHEAD = 12; // dorong sedikit maju di sepanjang garis, bukan cuma tegak lurus kembali
// Ditemukan lewat pengujian RCON langsung di server live: streaming chunk BERKELANJUTAN (per-tick,
// berdasar posisi berjalan) berhenti total untuk koneksi ini setelah burst awal saat login - bahkan
// teleport server-otoritatif ke posisi jauh di luar area yang sudah dikenal (tanpa gerakan klien sama
// sekali) tetap TIDAK memicu paket chunk baru walau didiamkan 10 detik penuh. TAPI login/reconnect
// BARU terbukti selalu memberi burst chunk segar di sekitar posisi SEKARANG - jadi solusinya bukan
// memperbaiki streaming (di luar kendali kita, itu perilaku server), tapi memutus & menyambung ulang
// koneksi secara berkala kalau graf sudah lama tidak bertambah DAN bot sudah benar-benar berpindah
// jauh dari posisi terakhir kali graf bertambah (supaya tidak reconnect sia-sia saat memang masih
// macet lokal di tempat yang sama - reconnect tidak akan membantu itu).
const CHUNK_REFRESH_STALL_MS = 45000;
const CHUNK_REFRESH_MIN_DISTANCE_MOVED = 12;

function rotateVector(dx, dz, angleRad) {
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
}

/**
 * @param {object} options
 * @param {{x:number,y:number,z:number}} options.goal - Koordinat base tujuan.
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.botName]
 * @param {number} [options.protocolVersion]
 * @param {(record: object) => void} [options.onDecision] - Dipanggil tiap tick dengan catatan
 *   keputusan terstruktur (posisi, blok yang dicek, jenis keputusan) - dipakai dashboard live.
 * @param {(message: string) => void} [options.onLog] - Log ringkas berbahasa Indonesia.
 * @param {(summary: object) => void} [options.onFinish]
 * @returns {{ stop: (reason?: string) => void }}
 */
function startWalkToBaseBot(options) {
  const GOAL = options.goal;
  // Nama TETAP (bukan acak per sesi) supaya op/whitelist di server tetap berlaku di setiap restart -
  // sebelumnya nama acak (WalkToBase_XXXX) berarti tiap koneksi baru dianggap akun baru oleh server.
  const BOT_NAME = options.botName || 'AutoCompanionBot';
  const log = options.onLog || (() => {});
  const onDecision = options.onDecision || (() => {});
  const onFinish = options.onFinish || (() => {});
  const CREEPER_DANGER_RADIUS = options.creeperDangerRadius ?? DEFAULT_CREEPER_DANGER_RADIUS;
  const HOSTILE_DANGER_RADIUS = options.hostileDangerRadius ?? DEFAULT_HOSTILE_DANGER_RADIUS;

  const client = new LiveProtocolClient({
    host: options.host, port: options.port, username: BOT_NAME,
    protocolVersion: options.protocolVersion,
    autoReconnect: true,
    maxReconnectAttempts: 999,
    reconnectBaseDelayMs: 2000,
    movementHeartbeatEnabled: false
  });

  const engine = new RichVoxelSpatialEngine((x, y, z) => client.getBlockName(x, y, z));

  const connectivityGraph = createConnectivityGraph(engine);
  // Kalau ada data hasil sapuan offline (terbang+reconnect lewat RCON, lihat sweepChunksViaRcon.js
  // / runChunkSweep.js), muat langsung sebagai titik awal graf - bot tidak perlu menemukan ulang
  // korridor spawn->goal dari nol lewat eksplorasi reaktif (yang berulang kali terjebak hazard/mob/
  // tebing sepanjang sesi ini), karena rutenya sudah pernah dipetakan dan diverifikasi offline.
  try {
    const sweepPath = require('path').join(__dirname, '..', '..', 'data', 'sweptChunkGraph.json');
    if (require('fs').existsSync(sweepPath)) {
      const swept = JSON.parse(require('fs').readFileSync(sweepPath, 'utf8'));
      connectivityGraph.seedNodes(swept.nodes);
      log(`Data sapuan offline dimuat (${swept.nodes.length} simpul, disapu ${swept.sweptAt}) - graf awal sudah mencakup korridor spawn->goal.`);
    }
  } catch (e) {
    log(`Gagal memuat data sapuan offline (dilanjutkan tanpa itu): ${e.message}`);
  }
  // Peta reward/punishment PERSISTEN per kolom - lihat rewardMap.js. Beda dari recentEscapeTargets
  // (blacklist di bawah, lupa dalam ~6 detik): skor di sini TERAKUMULASI sepanjang sesi, jadi kolom
  // yang berulang kali gagal/stall makin lama makin dihindari secara nyata, bukan cuma "istirahat
  // sebentar" - inilah yang dipakai untuk mengurangi bot benar-benar berputar di lingkaran yang sama.
  const rewardMap = createRewardMap();
  let chunkPacketsReceived = 0;
  let lastGraphGrowthAt = Date.now();
  let lastGraphGrowthPos = null;
  let refreshingConnection = false;
  client.on('chunk_loaded', ({ chunkX, chunkZ }) => {
    chunkPacketsReceived++;
    const hintY = client.position ? Math.floor(client.position.y) : 64;
    const versionBefore = connectivityGraph.getVersion();
    connectivityGraph.ingestChunk(chunkX, chunkZ, hintY);
    // Log SETIAP chunk baru yang benar-benar menambah simpul baru ke graf - dipakai memverifikasi
    // langsung apakah server memang berhenti mengirim chunk baru (klaim live: "chunk tidak ter
    // load lagi") atau paket chunk tetap masuk tapi cuma tidak menambah simpul baru (mis. chunk
    // yang sama dikirim ulang server, atau bot memang belum melewati batas chunk manapun).
    if (connectivityGraph.getVersion() !== versionBefore) {
      lastGraphGrowthAt = Date.now();
      lastGraphGrowthPos = client.position ? { x: client.position.x, z: client.position.z } : null;
      log(`Chunk baru dimuat (${chunkX},${chunkZ}) - graf sekarang ${connectivityGraph.nodeCount()} simpul (total paket chunk diterima sejauh ini: ${chunkPacketsReceived}).`);
    }
  });

  // Streaming chunk BERKELANJUTAN server ini terbukti berhenti setelah burst awal saat login/join
  // (dikonfirmasi lewat pengujian RCON: teleport server-otoritatif ke area jauh + didiamkan 10 detik
  // penuh tetap nol paket chunk baru) - tapi login/reconnect BARU selalu memberi burst segar di
  // sekitar posisi sekarang. Jadi kalau graf sudah lama sekali tidak bertambah PADAHAL bot sudah
  // benar-benar berpindah jauh dari posisi terakhir kali bertambah (bukan cuma macet lokal di tempat
  // yang sama - reconnect tidak akan membantu kasus itu), putus & sambung ulang koneksi supaya
  // mendapat burst chunk segar di sekitar posisi baru ini.
  async function refreshConnectionIfStale(pos) {
    if (refreshingConnection || finished || stopped) return;
    if (Date.now() - lastGraphGrowthAt < CHUNK_REFRESH_STALL_MS) return;
    if (lastGraphGrowthPos) {
      const movedDist = Math.hypot(pos.x - lastGraphGrowthPos.x, pos.z - lastGraphGrowthPos.z);
      if (movedDist < CHUNK_REFRESH_MIN_DISTANCE_MOVED) return;
    }
    refreshingConnection = true;
    log(`Graf tidak bertambah ${((Date.now() - lastGraphGrowthAt) / 1000).toFixed(0)}s walau bot sudah berpindah - putus & sambung ulang koneksi untuk paksa burst chunk segar di sekitar posisi sekarang.`);
    try {
      client.disconnect('refresh koneksi untuk paksa muat ulang chunk');
      await new Promise((r) => setTimeout(r, 1000));
      await client.connect();
      lastGraphGrowthAt = Date.now();
      lastGraphGrowthPos = client.position ? { x: client.position.x, z: client.position.z } : null;
      log('Koneksi berhasil disambung ulang - menunggu burst chunk baru.');
    } catch (e) {
      log(`Gagal menyambung ulang koneksi untuk refresh chunk: ${e.message}`);
    } finally {
      refreshingConnection = false;
    }
  }

  let spawnPos = null;
  let finished = false;
  let ticks = 0;
  let currentPath = null;
  let pathIndex = 0;
  let lastPathComputeAt = 0;
  let lastFrontierLogAt = 0; // throttle - tanpa ini, kalau genuinely macet lokal, log yang sama bisa terkirim tiap tick (setiap 50ms)
  let lastComputedGraphVersion = -1;
  let ctl = null;
  let blockedTicks = 0;
  // Jaring pengaman INDEPENDEN dari aheadSafe: kejadian nyata di atas menunjukkan aheadSafe bisa
  // "berkedip" true (mis. checkUp longgar walau eksekusinya gagal), me-reset blockedTicks berulang
  // kali tanpa PERNAH mencapai ambang escape search, walau posisi sebenarnya beku total selama
  // detik-detik. Ini melacak APAKAH BENAR-BENAR ada perpindahan nyata, terlepas dari apa kata
  // pengecekan blok - kalau tidak ada progres posisi sungguhan dalam jendela waktu ini, anggap macet.
  let stuckPositionRef = null;
  let stuckPositionRefAt = 0;
  const POSITION_STALL_WINDOW_MS = 3000;
  const POSITION_STALL_DISTANCE = 1.5;
  let recovering = false;
  let bestDistance = Infinity;
  let lastImprovedAt = Date.now();
  // Kolom (x,z pembulatan integer) yang sudah pernah disinggahi - dipakai sebagai sinyal progres
  // TOPOLOGIS terpisah dari jarak Euclidean lurus ke goal (lihat pemakaian di bawah).
  const visitedColumns = new Set();
  const recentEscapeTargets = [];
  let consecutiveEscapeRejections = 0;
  let totalEscapeFailureTicks = 0;
  let stuckRecoveryAngle = 0;
  let wallFollowSign = 0;
  let wallFollowSetAt = 0;
  let waypointChain = null;
  let waypointIndex = 0;
  let highestStableGroundY = null;
  let awaitingRespawnTeleport = false;
  let stopped = false;

  function isBlacklisted(x, z) {
    const now = Date.now();
    return recentEscapeTargets.some((e) => now - e.at < ESCAPE_BLACKLIST_COOLDOWN_MS && Math.hypot(e.x - x, e.z - z) < ESCAPE_BLACKLIST_RADIUS);
  }

  function wallFollowBiasedGoal(fromPos, trueGoal) {
    if (wallFollowSign === 0) return trueGoal;
    const dx = trueGoal.x - fromPos.x;
    const dz = trueGoal.z - fromPos.z;
    const rotated = rotateVector(dx, dz, wallFollowSign * WALL_FOLLOW_BIAS_ANGLE);
    return { x: fromPos.x + rotated.x, y: trueGoal.y, z: fromPos.z + rotated.z };
  }

  // Kalau navigasi taktis (wall-follow/escape/frontier-push) sudah membawa bot menyimpang TERLALU
  // JAUH tegak lurus dari garis lurus utama (spawn->base) - lihat MAX_LINE_DEVIATION - prioritaskan
  // KEMBALI ke garis dulu sebagai target acuan, bukan terus mengejar goal akhir apa adanya. Tanpa
  // ini, mengelilingi satu rintangan besar bisa membawa bot menyimpang sangat jauh ke samping/mundur
  // tanpa batas, karena tidak ada "gaya tarik" balik ke rute ideal sama sekali.
  function steeringReferenceGoal(fromPos) {
    if (!spawnPos) return GOAL;
    const deviation = distanceToLine(fromPos, spawnPos, GOAL);
    if (deviation <= MAX_LINE_DEVIATION) return GOAL;
    const closest = closestPointOnLine(fromPos, spawnPos, GOAL);
    const dx = GOAL.x - spawnPos.x, dz = GOAL.z - spawnPos.z;
    const lineDist = Math.hypot(dx, dz) || 1;
    return {
      x: closest.x + (dx / lineDist) * RETURN_TO_LINE_LOOKAHEAD,
      y: GOAL.y,
      z: closest.z + (dz / lineDist) * RETURN_TO_LINE_LOOKAHEAD
    };
  }

  function distanceToGoal(pos) { return Math.hypot(GOAL.x - pos.x, GOAL.z - pos.z); }

  let summaryPrinted = false;
  function printSummary(reason) {
    if (summaryPrinted) return;
    summaryPrinted = true;
    const finalPos = client.position;
    const startDist = spawnPos ? distanceToGoal(spawnPos) : null;
    const endDist = finalPos ? distanceToGoal(finalPos) : null;
    const summary = {
      reason, startDist, endDist,
      progress: startDist && endDist ? startDist - endDist : null,
      ticks
    };
    log(`Ringkasan: ${reason} | jarak awal=${startDist?.toFixed(1)} jarak akhir=${endDist?.toFixed(1)} tick=${ticks}`);
    onFinish(summary);
  }

  function finish(reason) {
    if (finished) return;
    finished = true;
    printSummary(reason);
    client.disconnect(reason);
  }

  client.on('teleport', (pos) => {
    if (!spawnPos) { spawnPos = pos; return; }
    if (awaitingRespawnTeleport) {
      awaitingRespawnTeleport = false;
      spawnPos = pos;
      highestStableGroundY = null;
      waypointChain = null;
      waypointIndex = 0;
      currentPath = null;
      lastComputedGraphVersion = -1;
      bestDistance = Infinity;
      lastImprovedAt = Date.now();
      blockedTicks = 0;
      stuckPositionRef = null;
      visitedColumns.clear();
      consecutiveEscapeRejections = 0;
      totalEscapeFailureTicks = 0;
      stuckRecoveryAngle = 0;
      wallFollowSign = 0;
      ctl = null;
      log(`Respawn mendarat di area baru (${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}) - semua referensi navigasi di-reset.`);
      return;
    }
    if (ctl) {
      ctl.resyncToServer();
      log(`Koreksi posisi dari server - sinkronkan ulang simulasi fisika lokal ke (${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}).`);
    }
  });
  client.on('error', (err) => log(`ERROR (non-fatal, koneksi tetap jalan): ${err.message}`));
  client.on('dead', () => {
    log('Bot mati - menunggu respawn otomatis, koneksi tetap hidup');
    currentPath = null;
    awaitingRespawnTeleport = true;
  });
  client.on('kicked', (reason) => { log(`DIKICK SERVER (di luar kendali kita): ${reason}`); finish('dikick server: ' + reason); });

  function tick() {
    if (finished || stopped) return;
    if (!client.socket || client.socket.destroyed) {
      setTimeout(tick, 1000);
      return;
    }
    const pos = client.position;
    if (!pos || client.health <= 0) { setTimeout(tick, 300); return; }

    if (!ctl) ctl = createPhysicsController(client);
    if (!waypointChain && spawnPos) {
      waypointChain = buildWaypointChain(spawnPos, GOAL, WAYPOINT_SPACING);
      waypointIndex = waypointChain.length > 1 ? 1 : 0;
      log(`Rute strategis dibuat: ${waypointChain.length} waypoint dari spawn ke base.`);
    }
    if (waypointChain) {
      const newIndex = advanceWaypoint(waypointChain, waypointIndex, pos, WAYPOINT_REACH_RADIUS);
      if (newIndex !== waypointIndex) {
        waypointIndex = newIndex;
        currentPath = null;
        log(`Waypoint ${waypointIndex + 1}/${waypointChain.length} tercapai.`);
      }
    }
    const localGoal = waypointChain ? { x: waypointChain[waypointIndex].x, z: waypointChain[waypointIndex].z, y: GOAL.y } : GOAL;

    const dist = distanceToGoal(pos);
    if (dist < 3) return finish('SAMPAI di dekat base');

    refreshConnectionIfStale(pos); // fire-and-forget - tick() sendiri sudah menahan diri lewat cek client.socket kalau sedang reconnect

    const colKey = `${Math.floor(pos.x)},${Math.floor(pos.z)}`;
    const isNewColumn = !visitedColumns.has(colKey);
    if (isNewColumn) visitedColumns.add(colKey);

    if (dist < bestDistance - IMPROVEMENT_EPSILON) {
      bestDistance = dist;
      lastImprovedAt = Date.now();
      rewardMap.reward(pos.x, pos.z, 1);
      if (wallFollowSign !== 0) { log('Progres nyata lagi - lepas komitmen susur sisi.'); wallFollowSign = 0; }
    } else if (isNewColumn) {
      // Genuinely menjelajah kolom yang BELUM PERNAH dikunjungi, walau jarak lurus (Euclidean) ke
      // goal belum membaik - di gua/labirin, progres topologis nyata SERING butuh menjauh dulu dari
      // garis lurus goal untuk memutar rintangan (live data nyata: dist berayun 337-361 tanpa tren,
      // padahal bot terus berpindah ke area baru). STALL yang cuma mengukur jarak Euclidean salah
      // mengira ini "macet" dan memaksa rencana baru + kadang membalik sisi susur BERULANG-ULANG,
      // padahal bot sedang bergerak produktif - inilah pola "berputar-putar" yang sebenarnya. Anggap
      // eksplorasi kolom baru sebagai progres juga (reset timer stall), TAPI JANGAN sentuh
      // wallFollowSign/currentPath supaya rencana yang sedang jalan tidak dibuang sia-sia.
      lastImprovedAt = Date.now();
    } else if (Date.now() - lastImprovedAt > STALL_TIMEOUT_MS) {
      log(`STALL terdeteksi (${((Date.now() - lastImprovedAt) / 1000).toFixed(0)}s tanpa progres) - paksa rencana baru.`);
      rewardMap.punish(pos.x, pos.z, 2);
      currentPath = null;
      lastPathComputeAt = 0;
      bestDistance = dist;
      lastImprovedAt = Date.now();
      if (wallFollowSign !== 0 && Date.now() - wallFollowSetAt > WALL_FOLLOW_RESET_MS) {
        log('Susur sisi lama tak membuahkan hasil - coba sisi sebaliknya.');
        wallFollowSign = 0;
      }
    }

    if (spawnPos && pos.y < spawnPos.y - CATASTROPHIC_FALL_THRESHOLD) {
      return finish(`STOP DARURAT KATASTROPIK - Y jatuh ${(spawnPos.y - pos.y).toFixed(0)} blok, di luar skenario normal`);
    }

    if (ctl.isFreefalling()) {
      if (!recovering) {
        recovering = true;
        log(`Freefall terdeteksi (Y=${pos.y.toFixed(1)}) - berhenti bergerak, menunggu mendarat. Koneksi TETAP hidup.`);
        currentPath = null;
      }
      onDecision({
        tick: ticks, t: Date.now(), pos: { x: pos.x, y: pos.y, z: pos.z }, dist,
        waypoint: waypointChain ? `${waypointIndex + 1}/${waypointChain.length}` : null,
        graphNodes: connectivityGraph.nodeCount(), decision: 'FREEFALL_WAIT',
        target: null, blocksChecked: [], aheadSafe: false,
        onGround: ctl.player.entity.onGround, blockedTicks, wallFollowSign, hostiles: 0
      });
      ctl.tick();
      ticks++;
      setTimeout(tick, TICK_MS);
      return;
    }
    if (recovering && ctl.player.entity.onGround) {
      recovering = false;
      blockedTicks = 0;
      log(`Sudah mendarat di Y=${pos.y.toFixed(1)}, lanjut navigasi normal.`);
    }
    if (recovering) {
      ctl.tick();
      ticks++;
      setTimeout(tick, TICK_MS);
      return;
    }

    if (ctl.player.entity.onGround) {
      highestStableGroundY = highestStableGroundY === null ? pos.y : Math.max(highestStableGroundY, pos.y);
    }

    const hostiles = client.getNearbyHostiles(pos, 32);
    let targetPoint = null;
    let noRealPlan = false;
    let decisionType = 'NORMAL_FOLLOW';

    if (hostiles.length > 0) {
      const nearest = hostiles[0];
      const dangerRadius = nearest.name === 'creeper' ? CREEPER_DANGER_RADIUS : HOSTILE_DANGER_RADIUS;
      if (nearest.distance <= dangerRadius) {
        const SWARM_AWARENESS_RADIUS = 10;
        const nearby = hostiles.filter((h) => h.distance <= SWARM_AWARENESS_RADIUS);
        let awayX, awayZ;
        if (nearby.length >= 3) {
          const cx = nearby.reduce((s, h) => s + h.x, 0) / nearby.length;
          const cz = nearby.reduce((s, h) => s + h.z, 0) / nearby.length;
          awayX = pos.x - cx; awayZ = pos.z - cz;
        } else {
          awayX = pos.x - nearest.x; awayZ = pos.z - nearest.z;
        }
        const away = Math.hypot(awayX, awayZ) || 1;
        targetPoint = { x: pos.x + (awayX / away) * dangerRadius, z: pos.z + (awayZ / away) * dangerRadius };
        currentPath = null;
        decisionType = 'HOSTILE_RETREAT';
      }
    }

    if (!targetPoint) {
      const now = Date.now();
      // Tebak ulang rute HANYA kalau benar-benar perlu: jalur lama habis, ATAU peta yang dikenal
      // benar-benar berubah (chunk baru dimuat - lihat connectivityGraph.getVersion()), ATAU
      // sudah lama sekali tanpa pengecekan sama sekali (jaring pengaman, bukan pemicu utama).
      // Sebelumnya recompute jalan tiap 8 detik TERLEPAS ada info baru atau tidak - buang waktu
      // menjelajah ulang data yang sudah persis diketahui, alih-alih benar-benar berjalan maju
      // (recompute yang mahal itu memakan jatah tick yang seharusnya dipakai untuk gerak nyata).
      const graphVersion = connectivityGraph.getVersion();
      const graphChanged = graphVersion !== lastComputedGraphVersion;
      const needsRecompute = !currentPath || pathIndex >= currentPath.length
        || (graphChanged && now - lastPathComputeAt > 150) // secepat mungkin tapi tetap redam kalau banyak chunk masuk beruntun dalam satu tick burst
        || now - lastPathComputeAt > PATH_RECOMPUTE_SAFETY_INTERVAL_MS;
      // Bug nyata: kalau posisi sekarang benar-benar terkurung total (findPath mengembalikan null -
      // nol tetangga valid sama sekali dari voxel tempat berdiri), currentPath tetap null setelah
      // dicoba, jadi kondisi "!currentPath" di atas langsung true LAGI di tick berikutnya - memicu
      // seluruh pipeline mahal (coarse+frontier+fine findPath) diulang TIAP TICK (setiap 50ms)
      // tanpa henti, membanjiri log dan tidak pernah memberi kesempatan mekanisme
      // escape/stuck-probe (yang justru dirancang untuk kasus ini) benar-benar berjalan. Redam:
      // kalau percobaan TERAKHIR gagal total (null), tunggu sebentar sebelum mencoba pipeline mahal
      // itu lagi - blockedTicks/escape/stuck-probe di bawah tetap jalan normal tiap tick sementara itu.
      const lastAttemptFailedCompletely = currentPath === null && lastPathComputeAt > 0;
      const inFailureBackoff = lastAttemptFailedCompletely && now - lastPathComputeAt < 1000;
      if (needsRecompute && !inFailureBackoff) {
        lastPathComputeAt = now;
        lastComputedGraphVersion = graphVersion;
        // Coba rencana LENGKAP dari sini sampai BASE ASLI dulu (bukan cuma waypoint terdekat) -
        // graf persisten murah untuk diquery (satu simpul per kolom), jadi begitu peta yang dikenal
        // sudah mencakup arah goal, langsung dapat rute utuh start->finish, bukan cuma beberapa
        // blok di depan. Kalau goal asli belum tercakup peta (masih terlalu jauh/belum dikenal),
        // baru turun ke waypoint strategis terdekat sebagai target yang lebih realistis dicapai.
        const biasedFullGoal = wallFollowBiasedGoal(pos, steeringReferenceGoal(pos));
        let coarsePath = connectivityGraph.findPath(pos, biasedFullGoal, { maxNodes: 20000 });
        let fullPlanFound = coarsePath && coarsePath.length > 1;
        let frontierReference = biasedFullGoal;
        if (!fullPlanFound) {
          const biasedLocalGoal = wallFollowBiasedGoal(pos, localGoal);
          coarsePath = connectivityGraph.findPath(pos, biasedLocalGoal, { maxNodes: 20000 });
          frontierReference = biasedLocalGoal;
        }
        let localTarget;
        if (coarsePath && coarsePath.length > 1) {
          let idx = 0, accDist = 0;
          while (idx < coarsePath.length - 1 && accDist < 16) {
            accDist += Math.hypot(coarsePath[idx + 1].x - coarsePath[idx].x, coarsePath[idx + 1].z - coarsePath[idx].z);
            idx++;
          }
          const coarseNode = coarsePath[idx];
          localTarget = { x: coarseNode.x, y: coarseNode.y, z: coarseNode.z };
          decisionType = 'COARSE_PATH';
          if (fullPlanFound) {
            log(`Rencana LENGKAP ditemukan sampai base asli (${coarsePath.length} simpul graf) - bukan cuma sebagian.`);
          }
        } else {
          const frontier = connectivityGraph.findFrontierTowardGoal(pos, frontierReference);
          if (frontier) {
            localTarget = { x: frontier.x, y: frontier.y, z: frontier.z };
            decisionType = 'FRONTIER_PUSH';
            if (Date.now() - lastFrontierLogAt > 2000) {
              lastFrontierLogAt = Date.now();
              log(`Goal di luar peta dikenal - dorong ke frontier (${frontier.x},${frontier.y},${frontier.z}).`);
            }
          } else {
            const guessY = findGroundY(engine, Math.floor(frontierReference.x), Math.floor(frontierReference.z), Math.floor(pos.y), 16) ?? Math.floor(pos.y);
            localTarget = { x: frontierReference.x, y: guessY, z: frontierReference.z };
            decisionType = 'GUESS_FALLBACK';
          }
        }
        currentPath = findPath(engine, pos, localTarget, { maxNodes: 8000 });
        pathIndex = 0;
        if (currentPath === null && Date.now() - lastFrontierLogAt > 2000) {
          lastFrontierLogAt = Date.now();
          log('Posisi sekarang terkurung total - tidak ada tetangga valid sama sekali dari sini. Menunggu escape/stuck-probe.');
        }
      }

      if (currentPath && currentPath.length > 1 && pathIndex < currentPath.length) {
        let wp = currentPath[pathIndex];
        let wdist = Math.hypot((wp.x + 0.5) - pos.x, (wp.z + 0.5) - pos.z);
        while (wdist < 0.35 && pathIndex < currentPath.length - 1) {
          pathIndex++;
          wp = currentPath[pathIndex];
          wdist = Math.hypot((wp.x + 0.5) - pos.x, (wp.z + 0.5) - pos.z);
        }
        targetPoint = { x: wp.x + 0.5, z: wp.z + 0.5 };
      } else {
        targetPoint = { x: pos.x, z: pos.z };
        noRealPlan = true;
      }
    }

    ctl.faceToward(targetPoint.x, targetPoint.z);

    const yaw = ctl.player.entity.yaw;
    const aheadX = pos.x + (-Math.sin(Math.PI - yaw)) * 1.0;
    const aheadZ = pos.z + (Math.cos(Math.PI - yaw)) * 1.0;
    const ax = Math.floor(aheadX), az = Math.floor(aheadZ), ay = Math.floor(pos.y);
    const checkSame = engine.evaluateNodePassability(ax, ay, az);
    const checkUp = engine.evaluateNodePassability(ax, ay + 1, az);
    const checkDown = engine.evaluateNodePassability(ax, ay - 1, az);
    const descentFloor = highestStableGroundY === null ? -Infinity : highestStableGroundY - MAX_DESCENT_BUDGET;
    const withinDescentBudget = ay - 1 >= descentFloor;
    const ahead2X = pos.x + -Math.sin(yaw) * 2.0;
    const ahead2Z = pos.z + -Math.cos(yaw) * 2.0;
    const ax2 = Math.floor(ahead2X), az2 = Math.floor(ahead2Z);
    const groundAhead2 = findGroundY(engine, ax2, az2, ay, 4);
    const noCliffAhead = groundAhead2 !== null && groundAhead2 >= descentFloor;
    const aheadSafe = !noRealPlan && withinDescentBudget && noCliffAhead && (checkSame.passable || checkUp.passable || checkDown.passable);

    ctl.controls.forward = aheadSafe;
    ctl.controls.sprint = true;

    if (stuckPositionRef === null) {
      stuckPositionRef = { x: pos.x, z: pos.z };
      stuckPositionRefAt = Date.now();
    } else if (Math.hypot(pos.x - stuckPositionRef.x, pos.z - stuckPositionRef.z) > POSITION_STALL_DISTANCE) {
      stuckPositionRef = { x: pos.x, z: pos.z };
      stuckPositionRefAt = Date.now();
    }
    const positionStalled = Date.now() - stuckPositionRefAt > POSITION_STALL_WINDOW_MS;

    if (!aheadSafe || positionStalled) {
      blockedTicks++;
      if (blockedTicks >= BLOCKED_TICKS_BEFORE_ESCAPE_SEARCH) {
        const minY = highestStableGroundY === null ? -Infinity : highestStableGroundY - MAX_DESCENT_BUDGET;
        const ringRadii = consecutiveEscapeRejections >= 2 ? WIDE_RING_RADII : undefined;
        // Kalau sudah menyimpang jauh dari garis utama, arahkan escape ke rute ideal juga (bukan
        // cuma waypoint terdekat) - supaya menghindari rintangan tidak diam-diam menambah simpangan
        // yang sudah besar.
        const escapeReference = distanceToLine(pos, spawnPos || pos, GOAL) > MAX_LINE_DEVIATION ? steeringReferenceGoal(pos) : localGoal;
        const searchGoal = wallFollowSign === 0 ? escapeReference : wallFollowBiasedGoal(pos, escapeReference);
        // Lewati kandidat yang sudah TERBUKTI gagal (blacklist waktu ATAU reward map persisten) DI
        // DALAM pencarian itu sendiri, bukan cuma menolaknya setelah dikembalikan - tanpa ini, ring
        // yang sama terus mengusulkan kandidat "terbaik" itu-itu saja walau sudah berkali-kali
        // ditolak, membuat bot terjebak STUCK_PROBE selamanya walau ada kandidat lain yang valid.
        const escape = engine.findWideEscapeRoute(pos, searchGoal, {
          minY, ringRadii,
          isExcluded: (x, y, z) => isBlacklisted(x, z) || rewardMap.isHeavilyPunished(x, z)
        });
        if (escape && wallFollowSign === 0) {
          const goalDx = localGoal.x - pos.x, goalDz = localGoal.z - pos.z;
          const escDx = escape.x - pos.x, escDz = escape.z - pos.z;
          const cross = goalDx * escDz - goalDz * escDx;
          wallFollowSign = cross >= 0 ? 1 : -1;
          wallFollowSetAt = Date.now();
          log(`Mulai menyusuri sisi ${wallFollowSign > 0 ? 'kanan' : 'kiri'} secara konsisten.`);
        }
        if (escape) {
          consecutiveEscapeRejections = 0;
          currentPath = findPath(engine, pos, { x: escape.x, y: escape.y, z: escape.z }, { maxNodes: 2000 });
          pathIndex = 0;
          lastPathComputeAt = Date.now();
          decisionType = 'ESCAPE';
          log(`Buntu ${blockedTicks} tick - coba arah lain${ringRadii ? ' (jangkauan diperluas)' : ''}: (${escape.x},${escape.y},${escape.z}) via ${currentPath ? currentPath.length : 0} waypoint tervalidasi`);
          recentEscapeTargets.push({ x: escape.x, z: escape.z, at: Date.now() });
          blockedTicks = 0;
          ctl.controls.forward = false;
          onDecision({
            tick: ticks, t: Date.now(), pos: { x: pos.x, y: pos.y, z: pos.z }, dist,
            waypoint: waypointChain ? `${waypointIndex + 1}/${waypointChain.length}` : null,
            graphNodes: connectivityGraph.nodeCount(), decision: decisionType,
            target: { x: escape.x, y: escape.y, z: escape.z },
            path: currentPath ? currentPath.slice(pathIndex).map((p) => ({ x: p.x, y: p.y, z: p.z })) : [],
            blocksChecked: [], aheadSafe: false, onGround: ctl.player.entity.onGround,
            blockedTicks, wallFollowSign, hostiles: hostiles.length,
            rewardScore: rewardMap.getScore(pos.x, pos.z)
          });
          ctl.tick();
          ticks++;
          setTimeout(tick, TICK_MS);
          return;
        } else {
          // findWideEscapeRoute sendiri sudah mengecualikan kandidat yang terbukti gagal
          // (isExcluded di atas) - kalau tetap null di sini, artinya SEMUA kandidat di semua ring
          // sudah tereksklusi atau memang tidak ada yang passable sama sekali, bukan cuma satu
          // kandidat "terbaik" yang ditolak berulang.
          consecutiveEscapeRejections++;
          totalEscapeFailureTicks++;
          if (totalEscapeFailureTicks % 20 === 0) stuckRecoveryAngle += Math.PI / 4;
          const probeX = pos.x + Math.cos(stuckRecoveryAngle) * 3;
          const probeZ = pos.z + Math.sin(stuckRecoveryAngle) * 3;
          ctl.faceToward(probeX, probeZ);
          const pyaw = ctl.player.entity.yaw;
          const pax = Math.floor(pos.x + (-Math.sin(pyaw)) * 1.0);
          const paz = Math.floor(pos.z + (-Math.cos(pyaw)) * 1.0);
          const pay = Math.floor(pos.y);
          const probeSame = engine.evaluateNodePassability(pax, pay, paz);
          const probeUp = engine.evaluateNodePassability(pax, pay + 1, paz);
          const probeDown = engine.evaluateNodePassability(pax, pay - 1, paz);
          const probeSafe = (pay - 1 >= minY) && (probeSame.passable || probeUp.passable || probeDown.passable);
          ctl.controls.forward = probeSafe;
          ctl.controls.jump = true;
          decisionType = 'STUCK_PROBE';
        }
      }
    } else {
      blockedTicks = 0;
      consecutiveEscapeRejections = 0;
      totalEscapeFailureTicks = 0;
    }
    if (ctl.controls.jump !== true) {
      // Lompat PROAKTIF (bukan cuma reaktif setelah nabrak): prismarine-physics cuma memberi
      // dorongan vertikal instan (vel.y=0.42) saat jump ditekan SAAT itu juga - momentum maju
      // harus SUDAH ada bersamaan, bukan setelah nabrak (begitu isCollidedHorizontally jadi true,
      // kecepatan horizontal sudah kadung diredam tabrakan, jadi lompat sesudahnya cuma naik lurus
      // ke atas lalu jatuh balik di tempat, bukan benar-benar naik ke pijakan berikutnya). Kejadian
      // nyata: bot terjebak di lubang kecil, Y bolak-balik 58<->59 di posisi X/Z yang SAMA PERSIS
      // berkali-kali - checkSame terhalang tapi checkUp longgar (langkah naik 1 blok tersedia),
      // tapi lompat reaktif gagal mengeksekusinya, dan blockedTicks ikut ter-reset tiap kali checkUp
      // sempat kelihatan longgar (walau eksekusinya gagal), jadi TIDAK PERNAH mencapai ambang escape
      // search. Lompat proaktif begitu pola "langkah naik" terdeteksi - bukan menunggu sudah nabrak.
      const stepUpAvailable = !checkSame.passable && checkUp.passable;
      ctl.controls.jump = (ctl.player.entity.isCollidedHorizontally || stepUpAvailable) && ctl.player.entity.onGround;
    }

    onDecision({
      tick: ticks, t: Date.now(), pos: { x: pos.x, y: pos.y, z: pos.z }, dist,
      waypoint: waypointChain ? `${waypointIndex + 1}/${waypointChain.length}` : null,
      graphNodes: connectivityGraph.nodeCount(), decision: decisionType,
      target: targetPoint ? { x: targetPoint.x, z: targetPoint.z } : null,
      // Sisa rute yang SEDANG dipilih A* untuk dilalui (bukan riwayat yang sudah dilewati) - dipakai
      // Chunk Matrix untuk memberi border warna berbeda pada blok yang "akan" dilalui.
      path: currentPath ? currentPath.slice(pathIndex).map((p) => ({ x: p.x, y: p.y, z: p.z })) : [],
      // Garis "optimistik" lurus dari spawn ke base (rantai waypoint strategis, lihat
      // strategicRoute.js) - referensi jarak-jauh yang TIDAK tahu rintangan apapun, dipakai
      // visualizer untuk membandingkan jalur ideal vs jalur nyata yang memutar rintangan.
      goal: { x: GOAL.x, y: GOAL.y, z: GOAL.z },
      spawn: spawnPos ? { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z } : null,
      waypointChain: waypointChain || [],
      blocksChecked: [
        { x: ax, y: ay, z: az, label: 'ahead_same', passable: checkSame.passable, reason: checkSame.reason },
        { x: ax, y: ay + 1, z: az, label: 'ahead_up', passable: checkUp.passable, reason: checkUp.reason },
        { x: ax, y: ay - 1, z: az, label: 'ahead_down', passable: checkDown.passable, reason: checkDown.reason },
        { x: ax2, y: groundAhead2, z: az2, label: 'cliff_check_2ahead', passable: noCliffAhead, reason: groundAhead2 === null ? 'NO_GROUND_FOUND' : 'ground_found' }
      ],
      aheadSafe, withinDescentBudget, noCliffAhead, noRealPlan,
      onGround: ctl.player.entity.onGround, blockedTicks, wallFollowSign, hostiles: hostiles.length,
      // Skor reward/punishment PERSISTEN kolom tempat bot berdiri sekarang (lihat rewardMap.js) -
      // ditampilkan di Decision Inspector supaya terlihat kolom mana yang sudah "dipercaya" (positif)
      // vs "dicurigai berputar-putar" (negatif) oleh bot sepanjang sesi berjalan.
      rewardScore: rewardMap.getScore(pos.x, pos.z),
      chunkPacketsReceived
    });

    ctl.tick();
    ticks++;
    setTimeout(tick, TICK_MS);
  }

  client.connect().then(() => {
    setTimeout(() => { log('Mulai (fisika asli, tidak disconnect kecuali fatal)'); tick(); }, 2000);
  }).catch((e) => { log(`GAGAL koneksi awal: ${e.message}`); finish('gagal koneksi awal'); });

  return {
    stop(reason) {
      stopped = true;
      finish(reason || 'dihentikan manual');
    },
    // Snapshot penuh peta yang sudah "dibaca" (satu simpul per kolom x,z) - dipakai visualizer
    // "Chunk Matrix" di dashboard, bukan cuma jalur yang sudah dilewati bot.
    getGraphSnapshot() {
      return connectivityGraph.getAllNodes();
    },
    // Snapshot seluruh kolom yang punya skor reward/punishment non-nol - dipakai visualizer.
    getRewardSnapshot() {
      return rewardMap.getAllScores();
    }
  };
}

module.exports = { startWalkToBaseBot };

if (require.main === module) {
  const goalArg = process.argv[2];
  const [gx, gy, gz] = (goalArg || '-175,71,-325').split(',').map(Number);
  startWalkToBaseBot({
    goal: { x: gx, y: gy, z: gz },
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    protocolVersion: Number(process.env.MC_PROTOCOL) || 775,
    onLog: (msg) => console.log(msg),
    onDecision: () => {},
    onFinish: () => setTimeout(() => process.exit(0), 500)
  });
}
