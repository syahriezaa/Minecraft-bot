const { randomUUID } = require('node:crypto');

const cell = p => `cell:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function normalizeReservation(resource, defaultMode = 'exclusive') {
  const mode = resource?.mode === 'shared' || (typeof resource === 'string' && resource.startsWith('shared:'))
    ? 'shared' : defaultMode;
  if (typeof resource === 'string') return { resource: resource.startsWith('shared:') ? resource.slice(7) : resource, mode };
  if (typeof resource?.resource === 'string') {
    const value = resource.resource;
    return { resource: value.startsWith('shared:') ? value.slice(7) : value, mode };
  }
  return { resource: cell(resource?.position || resource), mode };
}

class SwarmReservations {
  constructor(memory, owner = randomUUID(), now = Date.now) {
    this.db = memory.db;
    this.owner = owner;
    this.now = now;
    this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS reservations (
      world TEXT NOT NULL, dimension TEXT NOT NULL, resource TEXT NOT NULL,
      owner TEXT NOT NULL, token TEXT NOT NULL, expiresAt INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'exclusive',
      PRIMARY KEY(world, dimension, resource, token)
    ); CREATE INDEX IF NOT EXISTS reservation_expiry ON reservations(expiresAt);
    CREATE TABLE IF NOT EXISTS bot_occupancy (
      world TEXT NOT NULL, dimension TEXT NOT NULL, owner TEXT NOT NULL,
      resource TEXT NOT NULL, expiresAt INTEGER NOT NULL,
      PRIMARY KEY(world,dimension,owner,resource)
    );
    CREATE TABLE IF NOT EXISTS reservation_waits (
      owner TEXT PRIMARY KEY, blockers TEXT NOT NULL, expiresAt INTEGER NOT NULL
    );`);
    try { this.db.exec("ALTER TABLE reservations ADD COLUMN mode TEXT NOT NULL DEFAULT 'exclusive'"); }
    catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
    const legacy = this.db.prepare(`SELECT world,dimension,resource,owner,token,expiresAt
      FROM reservations WHERE resource LIKE 'shared:%'`).all();
    if (legacy.length) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const insert = this.db.prepare(`INSERT INTO reservations(world,dimension,resource,owner,token,expiresAt,mode)
          VALUES (?,?,?,?,?,?,'shared') ON CONFLICT(world,dimension,resource,token) DO UPDATE SET
          expiresAt=MAX(reservations.expiresAt,excluded.expiresAt),
          mode=CASE WHEN reservations.mode='exclusive' THEN 'exclusive' ELSE 'shared' END`);
        const remove = this.db.prepare(`DELETE FROM reservations WHERE world=? AND dimension=? AND resource=? AND owner=? AND token=?`);
        for (const row of legacy) {
          insert.run(row.world, row.dimension, row.resource.slice(7), row.owner, row.token, row.expiresAt);
          remove.run(row.world, row.dimension, row.resource, row.owner, row.token);
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  acquire(context, resources, ttl = 30000) {
    if (this.closed || !context?.world || !context?.dimension) return null;
    const byResource = new Map();
    for (const raw of resources) {
      const normalized = normalizeReservation(raw);
      const previous = byResource.get(normalized.resource);
      byResource.set(normalized.resource, previous?.mode === 'exclusive' || normalized.mode === 'exclusive'
        ? { resource: normalized.resource, mode: 'exclusive' } : normalized);
    }
    const unique = [...byResource.values()];
    if (!unique.length || unique.length > 8192 || !Number.isFinite(ttl) || ttl < 1000 || ttl > 60000) throw new Error('Reservasi tidak valid');
    const now = this.now();
    const token = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM reservations WHERE expiresAt <= ?').run(now);
      const activeReservations = this.db.prepare('SELECT owner,mode FROM reservations WHERE world=? AND dimension=? AND resource=? AND expiresAt>?');
      const occupied = this.db.prepare('SELECT 1 FROM bot_occupancy WHERE world=? AND dimension=? AND resource=? AND owner!=? AND expiresAt>? LIMIT 1');
      for (const resource of unique) {
        const active = activeReservations.all(context.world, context.dimension, resource.resource, now);
        const otherOwners = new Set(active.filter(row => row.owner !== this.owner).map(row => row.owner));
        const activeOwners = new Set(active.map(row => row.owner));
        const incompatible = resource.mode === 'exclusive'
          ? otherOwners.size > 0 || active.some(row => row.owner === this.owner && row.mode !== 'exclusive')
          : active.some(row => row.mode !== 'shared') || (activeOwners.size >= 2 && !activeOwners.has(this.owner));
        const blockedByOccupant = resource.mode === 'exclusive' && occupied.get(context.world,context.dimension,resource.resource,this.owner,now);
        if (incompatible || blockedByOccupant) {
          this.db.exec('ROLLBACK'); return null;
        }
      }
      const insert = this.db.prepare('INSERT INTO reservations(world,dimension,resource,owner,token,expiresAt,mode) VALUES (?,?,?,?,?,?,?)');
      for (const resource of unique) insert.run(context.world, context.dimension, resource.resource, this.owner, token, now + ttl, resource.mode);
      this.db.exec('COMMIT');
      return { token, count: unique.length, ttl };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  occupy(context, positions) {
    if (this.closed || !context) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM bot_occupancy WHERE owner=? OR expiresAt<=?').run(this.owner,this.now());
      const put=this.db.prepare('INSERT INTO bot_occupancy VALUES (?,?,?,?,?)');
      for(const resource of new Set(positions.map(cell))) put.run(context.world,context.dimension,this.owner,resource,this.now()+5000);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  blockedCells(context) {
    if (this.closed || !context) return new Set();
    return new Set(this.db.prepare(`SELECT resource FROM reservations WHERE world=? AND dimension=? AND owner!=? AND expiresAt>?
      UNION SELECT resource FROM bot_occupancy WHERE world=? AND dimension=? AND owner!=? AND expiresAt>?`)
      .all(context.world,context.dimension,this.owner,this.now(),context.world,context.dimension,this.owner,this.now())
      .map(r=>r.resource)
      .filter(resource => String(resource).startsWith('cell:')));
  }

  recordWait(context, resources) {
    const wanted=new Set(resources);
    const rows=this.db.prepare(`SELECT owner,resource FROM reservations WHERE world=? AND dimension=? AND owner!=? AND expiresAt>?
      UNION SELECT owner,resource FROM bot_occupancy WHERE world=? AND dimension=? AND owner!=? AND expiresAt>?`)
      .all(context.world,context.dimension,this.owner,this.now(),context.world,context.dimension,this.owner,this.now());
    const blockers=[...new Set(rows.filter(r=>wanted.has(r.resource)).map(r=>r.owner))];
    this.db.prepare('INSERT OR REPLACE INTO reservation_waits VALUES (?,?,?)').run(this.owner,JSON.stringify(blockers),this.now()+10000);
    const graph=new Map(this.db.prepare('SELECT owner,blockers FROM reservation_waits WHERE expiresAt>?').all(this.now()).map(r=>[r.owner,JSON.parse(r.blockers)]));
    const seen=new Set();
    const visit=owner=>{if(owner===this.owner)return true;if(seen.has(owner))return false;seen.add(owner);return (graph.get(owner)||[]).some(visit);};
    return {blockers,deadlock:blockers.some(visit)};
  }

  renew(lease) {
    if (this.closed) return false;
    const now = this.now();
    const result = this.db.prepare('UPDATE reservations SET expiresAt=? WHERE owner=? AND token=? AND expiresAt>?')
      .run(now + lease.ttl, this.owner, lease.token, now);
    return Number(result.changes) === lease.count;
  }

  release(lease) {
    if (!this.closed && lease) this.db.prepare('DELETE FROM reservations WHERE owner=? AND token=?').run(this.owner, lease.token);
  }

  close() {
    if (this.closed) return;
    this.db.prepare('DELETE FROM reservations WHERE owner=?').run(this.owner);
    this.db.prepare('DELETE FROM bot_occupancy WHERE owner=?').run(this.owner);
    this.db.prepare('DELETE FROM reservation_waits WHERE owner=?').run(this.owner);
    this.closed = true;
  }
}

module.exports = { SwarmReservations, cell, normalizeReservation };
