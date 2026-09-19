const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '../../data/shared-world.sqlite');

class SharedWorldMemory {
  constructor(file = process.env.SHARED_WORLD_DB || DEFAULT_FILE) {
    const { DatabaseSync } = require('node:sqlite');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    const configuredBusyTimeout = Number(process.env.SHARED_WORLD_BUSY_TIMEOUT_MS);
    const busyTimeout = Number.isFinite(configuredBusyTimeout)
      ? Math.max(50, Math.min(2000, Math.floor(configuredBusyTimeout)))
      : 350;
    this.db.exec(`
      -- Multiple bot processes share this WAL database. Keep the synchronous
      -- retry window short: a long SQLite wait freezes the bot's event loop and
      -- therefore also freezes the dashboard HTTP server.
      PRAGMA busy_timeout = ${busyTimeout};
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS blocks (
        world TEXT NOT NULL, dimension TEXT NOT NULL,
        x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
        name TEXT NOT NULL, state TEXT NOT NULL, observedAt INTEGER NOT NULL,
        observer TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        conflict INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (world, dimension, x, y, z)
      );
      CREATE TABLE IF NOT EXISTS observers (
        world TEXT NOT NULL, dimension TEXT NOT NULL, observer TEXT NOT NULL,
        lastSeen INTEGER NOT NULL, PRIMARY KEY (world, dimension, observer)
      );
      CREATE TABLE IF NOT EXISTS semantic_observations (
        world TEXT NOT NULL, dimension TEXT NOT NULL, region TEXT NOT NULL,
        observer TEXT NOT NULL, observedAt INTEGER NOT NULL, analysis TEXT NOT NULL,
        PRIMARY KEY(world, dimension, region)
      );
      CREATE TABLE IF NOT EXISTS world_activity (
        world TEXT NOT NULL,dimension TEXT NOT NULL,kind TEXT NOT NULL,
        x INTEGER NOT NULL,y INTEGER NOT NULL,z INTEGER NOT NULL,observedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_area ON world_activity(world,dimension,x,y,z,observedAt);
    `);
    this.upsert = this.db.prepare(`INSERT INTO blocks
      (world, dimension, x, y, z, name, state, observedAt, observer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(world, dimension, x, y, z) DO UPDATE SET
        conflict = CASE WHEN excluded.observedAt = blocks.observedAt
          AND (blocks.conflict = 1 OR excluded.name != blocks.name OR excluded.state != blocks.state) THEN 1 ELSE 0 END,
        name = excluded.name, state = excluded.state, observedAt = excluded.observedAt,
        observer = excluded.observer, revision = blocks.revision + 1
      WHERE excluded.observedAt >= blocks.observedAt`);
  }

  observe({ world, dimension, observer, blocks, observedAt = Date.now() }) {
    if (!world || !dimension || !observer || !Number.isSafeInteger(observedAt)) {
      throw new Error('Identitas dunia/pengamat atau waktu tidak valid');
    }
    // Validasi seluruh batch sebelum transaksi; null berarti belum diketahui, bukan udara.
    const valid = blocks.filter(Boolean).map(block => {
      const p = block.position;
      if (!p || !['x', 'y', 'z'].every(k => Number.isInteger(p[k])) || !block.name) {
        throw new Error('Pengamatan blok tidak valid');
      }
      const properties = typeof block.getProperties === 'function' ? block.getProperties() : block.properties || {};
      const state = JSON.stringify(Object.fromEntries(Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))));
      return [world, dimension, p.x, p.y, p.z, block.name, state, observedAt, observer];
    });
    // A deferred transaction lets readers and other short observer batches run
    // before this batch actually needs the single SQLite writer lock.
    this.db.exec('BEGIN');
    try {
      for (const row of valid) this.upsert.run(...row);
      this.db.prepare(`INSERT INTO observers VALUES (?, ?, ?, ?)
        ON CONFLICT(world, dimension, observer) DO UPDATE SET lastSeen = MAX(lastSeen, excluded.lastSeen)`)
        .run(world, dimension, observer, observedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return valid.length;
  }

  getBlock(world, dimension, { x, y, z }) {
    const row = this.db.prepare('SELECT * FROM blocks WHERE world=? AND dimension=? AND x=? AND y=? AND z=?')
      .get(world, dimension, x, y, z);
    return row ? { ...row, properties: JSON.parse(row.state), needsResurvey: Boolean(row.conflict) } : null;
  }

  saveAnalysis({ world, dimension, observer }, analysis) {
    const {min,max}=analysis.bounds;
    const activity=this.db.prepare(`SELECT kind,COUNT(*) AS count FROM world_activity WHERE world=? AND dimension=?
      AND x>=? AND x<? AND y>=? AND y<? AND z>=? AND z<? AND observedAt>? GROUP BY kind`)
      .all(world,dimension,min.x,max.x,min.y,max.y,min.z,max.z,Date.now()-3600000);
    analysis.evidence.activity=activity;
    const counts=Object.fromEntries(activity.map(a=>[a.kind,a.count]));
    for(const hypothesis of analysis.hypotheses) {
      if(hypothesis.type==='crop_farm' && counts.crop_removed && counts.crop_planted) {
        hypothesis.status='supported_by_activity';hypothesis.reasons.push('crop_removal_and_planting_observed');
      }
    }
    const region = JSON.stringify(analysis.bounds);
    this.db.prepare(`INSERT INTO semantic_observations VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(world, dimension, region) DO UPDATE SET observer=excluded.observer,
      observedAt=excluded.observedAt, analysis=excluded.analysis WHERE excluded.observedAt>=semantic_observations.observedAt`)
      .run(world, dimension, region, observer, analysis.observedAt, JSON.stringify(analysis));
    this.db.prepare('DELETE FROM semantic_observations WHERE observedAt < ?').run(Date.now()-86400000);
  }

  recordActivity(context,kind,position) {
    if(!context)return;
    this.db.prepare('INSERT INTO world_activity VALUES (?,?,?,?,?,?,?)').run(context.world,context.dimension,kind,
      Math.floor(position.x),Math.floor(position.y),Math.floor(position.z),Date.now());
    this.db.prepare('DELETE FROM world_activity WHERE observedAt<?').run(Date.now()-86400000);
  }

  analyses() {
    return this.db.prepare('SELECT * FROM semantic_observations ORDER BY observedAt DESC LIMIT 100').all()
      .map(row => ({ world: row.world, dimension: row.dimension, observer: row.observer, ...JSON.parse(row.analysis) }));
  }

  summary() {
    return {
      worlds: this.db.prepare(`SELECT world, dimension, COUNT(*) AS blocks,
        SUM(conflict) AS conflicts, MAX(observedAt) AS lastObservedAt FROM blocks GROUP BY world, dimension`).all(),
      observers: this.db.prepare('SELECT * FROM observers ORDER BY lastSeen DESC LIMIT 200').all()
    };
  }

  close() { this.db.close(); }
}

module.exports = { SharedWorldMemory };
