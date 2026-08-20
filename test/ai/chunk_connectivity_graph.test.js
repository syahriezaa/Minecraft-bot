/**
 * @file chunk_connectivity_graph.test.js
 * @description Uji unit lapisan graf konektivitas PERSISTEN - berbeda dari findPath (pathfinder.js)
 * yang stateless dan menyapu ulang dari nol tiap dipanggil (dibatasi maxNodes, buang semua hasil
 * eksplorasi begitu selesai). Di sini, tiap chunk yang dimuat di-"scan" SEKALI (satu simpul per
 * kolom x,z, bukan per voxel) dan hasilnya DIPERTAHANKAN - panggilan findPath berikutnya memakai
 * ulang graf yang sudah dikenal, tidak mengulang eksplorasi dari nol setiap siklus recompute.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RichVoxelSpatialEngine } = require('../../src/ai/richVoxelSpatialEngine');
const { createConnectivityGraph } = require('../../src/ai/chunkConnectivityGraph');

function flatWorld(holes = []) {
  return (x, y, z) => {
    for (const h of holes) if (h.x === x && h.z === z && (h.yMin === undefined || (y >= h.yMin && y <= h.yMax))) return h.block;
    return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
  };
}

describe('createConnectivityGraph - ingestChunk', () => {
  it('harus menambahkan satu simpul per kolom (x,z) yang punya tanah valid dalam chunk 16x16', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);

    assert.equal(graph.nodeCount(), 256, 'chunk 16x16 penuh tanah datar harus menghasilkan 256 simpul');
    const node = graph.getNode(5, 5);
    assert.ok(node, 'kolom (5,5) harus punya simpul');
    assert.equal(node.y, 64);
  });

  it('kolom tanpa tanah valid (lubang tak berdasar) tidak boleh menghasilkan simpul', () => {
    const holes = [{ x: 5, z: 5, block: 'air' }]; // seluruh kolom (5,5) jadi udara, tak ada pijakan
    const engine = new RichVoxelSpatialEngine(flatWorld(holes));
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);

    assert.equal(graph.getNode(5, 5), null);
    assert.equal(graph.nodeCount(), 255);
  });

  it('kolom dengan tanah JAUH dari hintY (di luar jangkauan pencarian lama) tetap harus ketemu, bukan dianggap kosong - ditemukan dari kasus live nyata: chunk jauh yang baru dimuat lewat reconnect refresh punya elevasi asli sangat berbeda dari hintY (posisi bot SEKARANG, bukan posisi chunk itu), jadi pencarian lama (naik-turun bergantian dari hintY, maks di luar jangkauan) gagal ketemu permukaan sungguhan dan kolom itu dibuang begitu saja - padahal permukaannya ADA, cuma jauh di bawah. Sesuai permintaan: kalau pencarian awal "kosong" (tidak ketemu), turun terus 1 blok demi 1 blok sampai benar-benar ketemu permukaannya, di level berapapun itu.', () => {
    // Permukaan asli ada di y=20 (jauh di bawah hintY=64) - float dunia nyata Minecraft modern bisa
    // sampai y=-64, jadi pencarian HARUS bisa turun jauh lebih dalam dari jangkauan lama (32 blok).
    const world = (x, y, z) => {
      if (x === 5 && z === 5) return y < 20 ? 'stone' : (y === 20 ? 'grass_block' : 'air');
      return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
    };
    const engine = new RichVoxelSpatialEngine(world);
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);

    const node = graph.getNode(5, 5);
    assert.ok(node, 'kolom (5,5) harus tetap ketemu permukaannya walau jauh di bawah hintY');
    assert.equal(node.y, 21, 'harus mendarat tepat di atas permukaan (y=20), yaitu y=21');
  });

  it('pencarian dalam (fallback ke dasar dunia) TIDAK BOLEH menerima air mengambang tanpa dasar padat sebagai "tanah" - ditemukan dari bug live nyata: server ini pakai versi blok yang tidak dikenali tabel minecraft-data kita, jadi banyak blok asli di kedalaman resolve jadi "unknown_state_XXXX" (default diklasifikasi SOLID_FULL, membuat pencarian normal gagal total), lalu fallback dalam turun sampai ke dasar dunia (Y=-64) dan menemukan KOLAM AIR di dasar (tanpa dasar padat sama sekali di bawahnya, cuma void/data tak dimuat) - status "mengambang di air" (dirancang untuk berenang normal, bukan buat kasus ini) secara keliru diterima sebagai "tanah" valid, menghasilkan ratusan ribu simpul palsu rata di Y=-64 yang membentuk pola geometris tidak natural di peta.', () => {
    const world = (x, y, z) => {
      if (x === 7 && z === 7) {
        if (y === -64 || y === -63) return 'water'; // air mengambang di dasar dunia (kaki & kepala bebas) - TANPA dasar padat di bawahnya
        if (y < -64) return null; // void/data tak dimuat di bawah dasar dunia - tidak ada apa-apa
        return 'stone'; // padat total di atasnya (mensimulasikan "unknown_state" yang dianggap solid)
      }
      return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
    };
    const engine = new RichVoxelSpatialEngine(world);
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);

    assert.equal(graph.getNode(7, 7), null, 'kolom dengan air mengambang tanpa dasar padat di Y=-64 TIDAK BOLEH dianggap punya tanah valid');
  });

  it('kanopi pohon (daun) TIDAK BOLEH dianggap tanah - ditemukan dari kekhawatiran nyata: pohon/daun/blok menggantung bikin "satu Y per kolom" salah baca kanopi sebagai permukaan, padahal tanah asli jauh di bawahnya - pencarian tanah harus TEMBUS daun sampai ketemu permukaan sungguhan', () => {
    const world = (x, y, z) => {
      if (x === 9 && z === 9) {
        if (y === 68) return 'oak_leaves'; // kanopi pohon di atas
        if (y > 68 && y <= 72) return 'air'; // ruang kosong di atas kanopi
        if (y === 63) return 'grass_block'; // tanah ASLI jauh di bawah kanopi
        if (y > 63 && y < 68) return 'air'; // batang pohon disederhanakan jadi udara di test ini
        return 'stone';
      }
      return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
    };
    const engine = new RichVoxelSpatialEngine(world);
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 70); // hintY=70, persis di atas kanopi (y=68)

    const node = graph.getNode(9, 9);
    assert.ok(node, 'kolom dengan pohon harus tetap ketemu tanah aslinya');
    assert.equal(node.y, 64, 'harus tembus kanopi daun dan mendarat di atas tanah asli (y=63), yaitu y=64 - BUKAN mendarat di atas kanopi');
  });

  it('getAllNodes harus mengembalikan seluruh simpul yang sudah di-ingest - dipakai visualizer "matrix chunk" (butuh snapshot penuh, bukan cuma query per kolom)', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);
    graph.ingestChunk(1, 0, 64);

    const all = graph.getAllNodes();
    assert.equal(all.length, 512, 'dua chunk 16x16 penuh tanah datar harus menghasilkan 512 simpul total');
    assert.ok(all.some((n) => n.x === 5 && n.z === 5));
    assert.ok(all.some((n) => n.x === 20 && n.z === 5), 'harus mencakup simpul dari chunk kedua juga');
  });

  it('getVersion harus bertambah HANYA saat chunk baru benar-benar menambah simpul - dipakai caller untuk tahu kapan perlu tebak ulang rute (bukan lewat timer buta)', () => {
    // Ide inti: kalau chunk (0,0) sudah di-ingest, findPath di atasnya SELALU memakai data yang sama
    // persis sampai chunk baru benar-benar dimuat - re-planning berkala tanpa perubahan data cuma
    // buang waktu menjelajah ulang area yang sudah diketahui, bukannya benar-benar berjalan maju.
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    const v0 = graph.getVersion();
    graph.ingestChunk(0, 0, 64);
    const v1 = graph.getVersion();
    assert.ok(v1 > v0, 'versi harus naik setelah chunk baru benar-benar di-ingest');

    graph.ingestChunk(0, 0, 64); // chunk yang SAMA, sudah pernah - tidak menambah apapun
    const v2 = graph.getVersion();
    assert.equal(v2, v1, 'versi TIDAK boleh naik kalau ingest ulang chunk yang sudah dikenal (tidak ada data baru)');

    graph.ingestChunk(1, 0, 64); // chunk baru sungguhan
    const v3 = graph.getVersion();
    assert.ok(v3 > v2, 'versi harus naik lagi untuk chunk baru yang sungguhan berbeda');
  });

  it('ingest chunk yang sama dua kali tidak boleh menduplikasi atau mengubah simpul yang sudah ada', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);
    const countBefore = graph.nodeCount();
    graph.ingestChunk(0, 0, 64);

    assert.equal(graph.nodeCount(), countBefore);
  });

  it('seedNodes harus mengisi graf langsung dari data yang sudah dikumpulkan sebelumnya (mis. hasil sapuan RCON offline), tanpa perlu ingest ulang lewat engine/dunia nyata', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.seedNodes([{ x: 100, y: 70, z: 200 }, { x: 101, y: 70, z: 200 }]);

    assert.equal(graph.nodeCount(), 2);
    const node = graph.getNode(100, 200);
    assert.ok(node);
    assert.equal(node.y, 70);
  });

  it('seedNodes tidak boleh menimpa simpul yang sudah ada dari ingest sebelumnya (data langsung dari dunia nyata lebih dipercaya daripada data seed lama)', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64); // kolom (5,5) dapat y=64 (tanah asli) dari sini
    graph.seedNodes([{ x: 5, y: 999, z: 5 }]); // seed usang, seharusnya diabaikan

    assert.equal(graph.getNode(5, 5).y, 64, 'data ingest nyata tidak boleh ditimpa oleh seed');
  });

  it('seedNodes harus menaikkan getVersion() supaya caller tahu ada data baru untuk direncanakan ulang', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    const v0 = graph.getVersion();
    graph.seedNodes([{ x: 100, y: 70, z: 200 }]);

    assert.ok(graph.getVersion() > v0);
  });
});

describe('createConnectivityGraph - findPath (memakai ulang graf yang sudah di-ingest)', () => {
  it('harus tetap menghubungkan dua kolom bertetangga walau selisih elevasi >3 blok (tebing curam) - ditemukan dari sapuan offline nyata: korridor spawn->goal sepanjang 350+ blok pasti melewati banyak tebing/lembah, tapi getGraphNeighbors lama membatasi MAX_STEP_DOWN=3, jauh lebih ketat dari MAX_DESCENT_BUDGET=8 yang dipakai kebijakan turun di tempat lain (runWalkToBaseBot.js, pathfinder.js) - akibatnya graf terputus-putus di banyak titik walau datanya sendiri lengkap tanpa celah, dan findPath gagal total mencari rute lengkap.', () => {
    const engine = new RichVoxelSpatialEngine(() => 'air'); // engine tidak dipakai - seedNodes langsung isi graf
    const graph = createConnectivityGraph(engine);

    // Dua kolom bertetangga (x=0 dan x=1), selisih elevasi 6 blok (dalam MAX_DESCENT_BUDGET=8 tapi
    // di luar MAX_STEP_DOWN=3 lama).
    graph.seedNodes([{ x: 0, y: 70, z: 0 }, { x: 1, y: 64, z: 0 }]);

    const path = graph.findPath({ x: 0, y: 70, z: 0 }, { x: 1, y: 64, z: 0 });

    assert.ok(path, 'harus tetap menemukan jalur walau turun 6 blok ke tetangga');
    assert.equal(path.length, 2);
  });

  it('harus menemukan jalur HANYA lewat simpul yang sudah di-ingest, bukan menebak lewat kolom yang belum pernah discan', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64); // cuma chunk (0,0) yaitu x,z 0..15 - goal di luar itu tidak boleh ketemu

    const path = graph.findPath({ x: 2, y: 64, z: 2 }, { x: 100, y: 64, z: 100 });

    assert.equal(path, null, 'goal jauh di luar chunk yang di-ingest tidak boleh "ditebak" ketemu');
  });

  it('harus menemukan jalur langsung di dalam satu chunk yang sudah di-ingest', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);

    const path = graph.findPath({ x: 1, y: 64, z: 1 }, { x: 14, y: 64, z: 14 });

    assert.ok(path, 'harus menemukan jalur di dalam chunk yang sudah dikenal');
    const last = path[path.length - 1];
    assert.equal(last.x, 14);
    assert.equal(last.z, 14);
  });

  it('menambah (ingest) chunk tetangga harus MEMPERLUAS jangkauan findPath tanpa mengulang chunk pertama dari nol', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);

    graph.ingestChunk(0, 0, 64);
    const countAfterFirst = graph.nodeCount();
    let path = graph.findPath({ x: 1, y: 64, z: 1 }, { x: 20, y: 64, z: 1 });
    assert.equal(path, null, 'sebelum chunk tetangga di-ingest, goal di luar jangkauan');

    graph.ingestChunk(1, 0, 64); // chunk tetangga (x 16..31)
    assert.equal(graph.nodeCount(), countAfterFirst + 256, 'simpul chunk pertama tidak diulang, cuma menambah yang baru');

    path = graph.findPath({ x: 1, y: 64, z: 1 }, { x: 20, y: 64, z: 1 });
    assert.ok(path, 'setelah chunk tetangga di-ingest, goal yang tadinya di luar jangkauan sekarang ketemu');
    const last = path[path.length - 1];
    assert.equal(last.x, 20);
  });

  it('harus lebih memilih rute datar memutar daripada rute pendek yang perlu lompat (konsisten dengan aturan biaya di pathfinder.js)', () => {
    // Kolom (5,5) satu-satunya cara lewat adalah lompat ke y=65 - tapi kolom (5,6) di sebelahnya
    // tetap datar (y=64), jadi ada jalan memutar tanpa lompat sama sekali.
    const holes = [{ x: 5, z: 5, block: 'stone', yMin: 64, yMax: 64 }];
    const engine = new RichVoxelSpatialEngine(flatWorld(holes));
    const graph = createConnectivityGraph(engine);
    graph.ingestChunk(0, 0, 64);

    const path = graph.findPath({ x: 4, y: 64, z: 5 }, { x: 6, y: 64, z: 5 });

    assert.ok(path, 'harus menemukan jalur');
    const usedJumpColumn = path.some((p) => p.x === 5 && p.z === 5 && p.y === 65);
    assert.ok(!usedJumpColumn, 'harus memutar lewat kolom lain yang datar, bukan lompat di (5,65,5)');
  });
});

describe('createConnectivityGraph - findFrontierTowardGoal (keputusan "dorong ke area belum dikenal")', () => {
  it('kalau goal MASIH di dalam area yang sudah dikenal, tidak perlu cari frontier - kembalikan null (goal langsung dijangkau findPath biasa)', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);
    graph.ingestChunk(0, 0, 64);

    const frontier = graph.findFrontierTowardGoal({ x: 1, y: 64, z: 1 }, { x: 10, y: 64, z: 10 });

    assert.equal(frontier, null, 'goal di dalam chunk yang sudah di-ingest tidak butuh frontier-seeking');
  });

  it('kalau goal JAUH di luar area yang dikenal, harus mengembalikan titik di TEPI area dikenal yang paling condong ke arah goal - bukan sembarang tepi', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);
    graph.ingestChunk(0, 0, 64); // area dikenal: x,z 0..15

    // Goal jauh ke arah +X,+Z (di luar chunk yang di-ingest) - frontier harus condong ke sekitar
    // x=15 atau z=15 (tepi yang paling dekat ke arah goal), bukan ke x=0 atau z=0 (tepi yang menjauh).
    const frontier = graph.findFrontierTowardGoal({ x: 8, y: 64, z: 8 }, { x: 500, y: 64, z: 500 });

    assert.ok(frontier, 'harus menemukan titik frontier');
    assert.ok(frontier.x >= 12 || frontier.z >= 12, `frontier harus condong ke arah goal (+X,+Z), dapat (${frontier.x},${frontier.z})`);
  });

  it('frontier harus MELEWATI batas kolom yang sudah dikenal (bukan cuma berhenti tepat di tepinya) - kalau tidak, bot cuma "menyentuh" tepi tanpa pernah benar-benar melangkah ke chunk yang belum dimuat, dan server tidak pernah punya alasan mengirim chunk baru', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);
    graph.ingestChunk(0, 0, 64); // area dikenal: x,z 0..15 - kolom TERAKHIR yang dikenal ke arah +X adalah x=15

    const frontier = graph.findFrontierTowardGoal({ x: 8, y: 64, z: 8 }, { x: 500, y: 64, z: 8 });

    assert.ok(frontier, 'harus menemukan titik frontier');
    assert.ok(frontier.x > 15, `frontier harus MELEWATI kolom terakhir yang dikenal (x=15), dapat x=${frontier.x} - kalau cuma x<=15, bot tidak pernah benar-benar menyeberang ke chunk baru`);
  });

  it('tidak boleh terjebak celah lokal di sumbu yang salah - kejadian nyata: area dikenal berbentuk tidak beraturan (banyak "celah" X di satu baris), tapi goal jauh lebih condong ke arah Z, sehingga frontier HARUS tetap mendorong ke arah Z (batas sesungguhnya), bukan bolak-balik di sumbu X karena celah lokal kebetulan lebih dekat', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);
    graph.ingestChunk(0, 0, 64); // area utama: x,z 0..15
    graph.ingestChunk(2, 0, 64); // chunk TERPISAH jauh di x=32..47 (bukan tetangga langsung chunk 0)
    // -> ini menciptakan banyak "simpul tepi" semu di sekitar x=15/x=32 pada baris z yang sama,
    // yang bisa membuat pendekatan lama (skor per-simpul individual) terjebak bolak-balik di sana.

    // Bot di tepi chunk pertama (dekat x=15), goal jauh lebih condong ke arah -Z (turun) daripada +X.
    const frontier = graph.findFrontierTowardGoal({ x: 8, y: 64, z: 8 }, { x: 20, y: 64, z: -500 });

    assert.ok(frontier, 'harus menemukan titik frontier');
    assert.ok(frontier.z < 0, `frontier harus mendorong ke arah -Z (batas sesungguhnya searah goal), dapat z=${frontier.z} - kalau z masih di dalam rentang dikenal (0..15), berarti terjebak celah lokal di sumbu X yang salah`);
  });

  it('frontier yang dikembalikan harus benar-benar tetangga dari area belum dikenal (punya sisi yang belum di-ingest)', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const graph = createConnectivityGraph(engine);
    graph.ingestChunk(0, 0, 64);
    graph.ingestChunk(1, 0, 64); // perluas ke x 16..31 juga - tepi lama (x=15) bukan frontier lagi

    // Goal MURNI ke arah +X (z sama dengan posisi start) - setelah chunk kedua di-ingest, frontier
    // yang paling searah goal seharusnya sudah maju ke x=31 (tepi terjauh yang masih dikenal),
    // bukan lagi berhenti di x=15 (skenario sebelumnya, goal diagonal, sengaja diuji terpisah).
    const frontier = graph.findFrontierTowardGoal({ x: 8, y: 64, z: 8 }, { x: 500, y: 64, z: 8 });

    assert.ok(frontier, 'harus menemukan simpul frontier');
    assert.ok(frontier.x >= 16, `frontier harus sudah maju melewati batas chunk pertama, dapat x=${frontier.x}`);
  });
});
