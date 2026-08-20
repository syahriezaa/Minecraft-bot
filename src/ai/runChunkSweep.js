/**
 * @file runChunkSweep.js
 * @description Runner CLI untuk sweepChunksViaRcon.js - kumpulkan peta korridor spawn->goal lewat
 * terbang+reconnect (lihat sweepChunksViaRcon.js), gabung dengan data sapuan sebelumnya (kalau ada),
 * lalu coba findPath OFFLINE di atas graf gabungan untuk melihat seberapa lengkap rencana yang bisa
 * dihasilkan.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const fs = require('fs');
const path = require('path');
const { sweepChunksViaRcon } = require('./sweepChunksViaRcon');

const SWEEP_DATA_PATH = path.join(__dirname, '..', '..', 'data', 'sweptChunkGraph.json');
// Titik spawn dunia asli (dikonfirmasi lewat probe langsung sebelumnya di sesi ini) - dipakai
// sebagai titik awal TETAP untuk sapuan, supaya tidak bergantung pada posisi "sekarang" bot yang
// bisa saja sudah ada di goal dari sapuan sebelumnya (itu akan membuat rute sapuan collapse jadi
// 1 titik trivial dan menimpa data bagus dengan sapuan kosong - kejadian nyata yang sudah terjadi).
const FIXED_START_POS = { x: -34.5, y: 61, z: -7.5 };

async function main() {
  const goal = { x: -175, y: 71, z: -325 };
  const { graph, waypoints } = await sweepChunksViaRcon({
    botName: 'AutoCompanionBot',
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    protocolVersion: Number(process.env.MC_PROTOCOL) || 775,
    goal,
    startPos: FIXED_START_POS,
    onLog: (msg) => console.log(msg)
  });

  // Gabung dengan data sapuan sebelumnya (kalau ada) - jangan pernah kehilangan area yang sudah
  // pernah terkumpul cuma karena sapuan kali ini kebetulan lebih pendek/gagal sebagian.
  if (fs.existsSync(SWEEP_DATA_PATH)) {
    const prev = JSON.parse(fs.readFileSync(SWEEP_DATA_PATH, 'utf8'));
    const beforeMerge = graph.nodeCount();
    graph.seedNodes(prev.nodes);
    console.log(`Digabung dengan data sapuan sebelumnya: +${graph.nodeCount() - beforeMerge} simpul lama yang belum ada di sapuan kali ini.`);
  }

  const start = waypoints[0];
  const startNode = graph.getNode(Math.floor(start.x), Math.floor(start.z));
  const goalNode = graph.getNode(Math.floor(goal.x), Math.floor(goal.z));
  console.log(`\n=== HASIL ===`);
  console.log(`Total simpul graf (gabungan): ${graph.nodeCount()}`);
  console.log(`Titik awal dikenal: ${startNode ? 'ya' : 'TIDAK'}`);
  console.log(`Titik goal dikenal: ${goalNode ? 'ya' : 'TIDAK'}`);

  if (startNode) {
    const foundPath = graph.findPath({ x: start.x, y: startNode.y, z: start.z }, goal, { maxNodes: 50000 });
    if (foundPath) {
      console.log(`Rencana OFFLINE ditemukan: ${foundPath.length} simpul dari awal ke titik terjauh yang dikenal.`);
      const last = foundPath[foundPath.length - 1];
      const distToGoal = Math.hypot(goal.x - last.x, goal.z - last.z);
      console.log(`Titik terakhir rencana: (${last.x},${last.y},${last.z}) - jarak sisa ke goal: ${distToGoal.toFixed(1)} blok.`);
    } else {
      console.log('Tidak ada rencana yang bisa dibuat dari graf yang terkumpul.');
    }
  }

  fs.mkdirSync(path.dirname(SWEEP_DATA_PATH), { recursive: true });
  fs.writeFileSync(SWEEP_DATA_PATH, JSON.stringify({ goal, sweptAt: new Date().toISOString(), nodes: graph.getAllNodes() }));
  console.log(`Graf disimpan ke ${SWEEP_DATA_PATH} - siap dipakai runWalkToBaseBot.js sebagai data awal.`);

  process.exit(0);
}

main().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
