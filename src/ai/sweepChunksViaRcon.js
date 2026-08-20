/**
 * @file sweepChunksViaRcon.js
 * @description Alat pengumpul data OFFLINE: terbang (spectator, lewat RCON) menyusuri rantai
 * waypoint dari spawn ke goal, memutus & menyambung ulang koneksi di tiap titik (satu-satunya cara
 * yang terbukti memaksa server mengirim burst chunk baru - lihat catatan panjang di
 * runWalkToBaseBot.js soal streaming chunk berkelanjutan yang berhenti setelah login), dan meng-
 * ingest semua chunk yang masuk ke SATU connectivityGraph yang terus bertambah. Tujuannya: kumpulkan
 * peta korridor spawn->goal secara sistematis TANPA bot harus benar-benar berjalan lewat bahaya
 * (mob, jurang, hazard) di jalur reaktif - baru setelah peta korridor terkumpul, findPath dijalankan
 * OFFLINE (tanpa koneksi) untuk menghasilkan rencana lengkap yang bisa dieksekusi bot jalan nyata.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { LiveProtocolClient } = require('../network/liveProtocolClient');
const { RichVoxelSpatialEngine } = require('./richVoxelSpatialEngine');
const { createConnectivityGraph } = require('./chunkConnectivityGraph');
const { buildWaypointChain } = require('./strategicRoute');
const { execSync } = require('child_process');

const WAYPOINT_SPACING = 40; // sedikit di bawah radius area yang biasa dimuat (~24 blok setengah-lebar) supaya tiap titik saling bersinggungan, tidak ada celah tak dikenal di antaranya
const CHUNK_SETTLE_MS = 2500; // waktu tunggu setelah reconnect sebelum lanjut ke titik berikutnya, supaya burst chunk awal sempat masuk semua

function rconExec(command) {
  const escaped = command.replace(/"/g, '\\"');
  if (process.env.MC_RCON_LOCAL === 'true') {
    // Dijalankan LANGSUNG di mesin yang sama dengan server Minecraft (lihat runLocalGridSweep.js) -
    // tidak perlu SSH/cloudflared sama sekali, jauh lebih cepat & tidak rentan hiccup jaringan jarak
    // jauh yang sebelumnya bikin sapuan gagal (ETIMEDOUT dsb).
    const pw = process.env.MC_RCON_PASSWORD || 'ghasol12345';
    const cmd = `python C:\\Users\\junaidi\\rcon_query.py ${pw} "${escaped}"`;
    return execSync(cmd, { encoding: 'utf8' }).trim();
  }
  // Dieksekusi via SSH+RCON dari mesin terpisah (mis. Mac ini) ke PC server Minecraft - lihat rcon_query.py.
  const cmd = `sshpass -e ssh -o StrictHostKeyChecking=accept-new -o "ProxyCommand=cloudflared access ssh --hostname %h" junaidi@sshjunaidi.fun "python C:\\Users\\junaidi\\rcon_query.py ghasol12345 \\"${escaped}\\""`;
  return execSync(cmd, { env: { ...process.env, SSHPASS: '2025' }, encoding: 'utf8' }).trim();
}

async function sweepChunksViaRcon({ botName, host, port, protocolVersion, goal, startPos, onLog = () => {} }) {
  const client = new LiveProtocolClient({
    host, port, username: botName, protocolVersion,
    autoReconnect: false, movementHeartbeatEnabled: false
  });
  const engine = new RichVoxelSpatialEngine((x, y, z) => client.getBlockName(x, y, z));
  const graph = createConnectivityGraph(engine);

  // WAJIB: event 'error' tanpa listener mematikan SELURUH proses Node - lihat catatan sama di
  // gridSweepViaRcon.js/patchSweepHoles.js (bug nyata: satu hiccup jaringan sesaat mematikan seluruh
  // sapuan).
  client.on('error', (err) => onLog(`ERROR jaringan (non-fatal, lanjut ke titik berikutnya): ${err.message}`));

  client.on('chunk_loaded', ({ chunkX, chunkZ }) => {
    const hintY = client.position ? Math.floor(client.position.y) : 70;
    const before = graph.getVersion();
    graph.ingestChunk(chunkX, chunkZ, hintY);
    if (graph.getVersion() !== before) onLog(`  chunk (${chunkX},${chunkZ}) di-ingest - graf sekarang ${graph.nodeCount()} simpul`);
  });

  onLog('Menghubungkan koneksi awal...');
  await client.connect();
  await new Promise((r) => setTimeout(r, CHUNK_SETTLE_MS));

  // Kalau caller memberi startPos eksplisit, teleport ke sana dulu SEBELUM mulai menyusun rute
  // sapuan - jangan percaya posisi "sekarang" begitu saja, karena kalau sapuan sebelumnya berhenti
  // tepat di goal (kasus nyata: sapuan sukses selalu berakhir di goal), rute berikutnya akan
  // collapse jadi 1 titik trivial dan MENIMPA data bagus yang sudah terkumpul dengan sapuan kosong.
  let spawnPos;
  if (startPos) {
    onLog(`Kembali ke titik awal tetap (${startPos.x}, ${startPos.z}) sebelum mulai sapuan...`);
    rconExec(`tp ${botName} ${startPos.x} ${startPos.y ?? 70} ${startPos.z}`);
    await new Promise((r) => setTimeout(r, 500));
    client.disconnect('kembali ke titik awal sebelum sapuan');
    await new Promise((r) => setTimeout(r, 800));
    await client.connect();
    await new Promise((r) => setTimeout(r, CHUNK_SETTLE_MS));
    spawnPos = { x: startPos.x, z: startPos.z };
  } else {
    // Pakai posisi NYATA hasil koneksi (bukan tebakan) sebagai titik awal rute sapuan.
    spawnPos = { x: client.position.x, z: client.position.z };
  }
  onLog(`Posisi awal sungguhan: (${spawnPos.x.toFixed(1)}, ${spawnPos.z.toFixed(1)})`);

  const centerline = buildWaypointChain(spawnPos, goal, WAYPOINT_SPACING);
  // Sapuan HANYA di garis lurus tidak cukup - kalau ada rintangan besar (jurang/tebing/gunung) yang
  // memotong garis lurus, tidak ada data di SAMPING garis untuk memberi A* pilihan memutar (kejadian
  // nyata: kanyon curam ~34 blok memutus konektivitas persis di tengah korridor, dan sapuan garis
  // lurus tidak pernah "melihat" jalan memutarnya). Tambah offset tegak lurus di tiap titik supaya
  // graf yang terkumpul punya LEBAR, bukan cuma satu garis tipis.
  const perpOffsets = [0, 48, -48];
  const dxTotal = goal.x - spawnPos.x, dzTotal = goal.z - spawnPos.z;
  const lineLen = Math.hypot(dxTotal, dzTotal) || 1;
  const perpX = -dzTotal / lineLen, perpZ = dxTotal / lineLen; // vektor tegak lurus arah garis

  const waypoints = [];
  for (const wp of centerline) {
    for (const off of perpOffsets) {
      waypoints.push({ x: wp.x + perpX * off, z: wp.z + perpZ * off });
    }
  }
  onLog(`Rute sapuan: ${waypoints.length} titik (${centerline.length} posisi utama x ${perpOffsets.length} offset lebar) dari spawn ke goal.`);

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const y = goal.y; // spectator - Y persis tidak penting untuk collision, dipakai cuma sebagai hintY awal
    onLog(`[${i + 1}/${waypoints.length}] Terbang ke (${wp.x.toFixed(0)}, ${y}, ${wp.z.toFixed(0)})...`);
    rconExec(`tp ${botName} ${wp.x.toFixed(1)} ${y} ${wp.z.toFixed(1)}`);
    await new Promise((r) => setTimeout(r, 500));
    onLog('  Sambung ulang koneksi untuk paksa burst chunk baru...');
    client.disconnect('sweep - reconnect untuk chunk baru');
    await new Promise((r) => setTimeout(r, 800));
    await client.connect();
    await new Promise((r) => setTimeout(r, CHUNK_SETTLE_MS));
  }

  onLog(`Sapuan selesai. Total simpul graf: ${graph.nodeCount()}.`);
  client.disconnect('sweep selesai');

  return { graph, waypoints };
}

module.exports = { sweepChunksViaRcon, rconExec };
