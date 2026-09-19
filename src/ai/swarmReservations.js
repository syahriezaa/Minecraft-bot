const { randomUUID } = require('node:crypto');

const cell = p => `cell:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

class SwarmReservations {
  constructor(memory, owner = randomUUID(), now = Date.now) {
    this.db = memory.db;
    this.owner = owner;
    this.now = now;
    this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS reservations (
      world TEXT NOT NULL, dimension TEXT NOT NULL, resource TEXT NOT NULL,
      owner TEXT NOT NULL, token TEXT NOT NULL, expiresAt INTEGER NOT NULL,
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
  }

  acquire(context, resources, ttl = 30000) {
    if (this.closed || !context?.world || !context?.dimension) return null;
    const unique = [...new Set(resources)];
    if (!unique.length || unique.length > 8192 || !Number.isFinite(ttl) || ttl < 1000 || ttl > 60000) throw new Error('Reservasi tidak valid');
    const now = this.now();
    const token = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM reservations WHERE expiresAt <= ?').run(now);
      const checkExclusive = this.db.prepare('SELECT 1 FROM reservations WHERE world=? AND dimension=? AND resource=? AND owner!=? LIMIT 1');
      const checkShared = this.db.prepare('SELECT COUNT(DISTINCT owner) AS owners FROM reservations WHERE world=? AND dimension=? AND resource=? AND owner!=?');
      const occupied = this.db.prepare('SELECT 1 FROM bot_occupancy WHERE world=? AND dimension=? AND resource=? AND owner!=? AND expiresAt>? LIMIT 1');
      for (const resource of unique) {
        // `shared:cell:*` dipakai khusus window chest/barrel. Dua bot boleh
        // membuka container yang sama, tetapi bot ketiga tetap harus menunggu.
        const otherOwners = String(resource).startsWith('shared:')
          ? Number(checkShared.get(context.world, context.dimension, resource, this.owner)?.owners || 0)
          : (checkExclusive.get(context.world, context.dimension, resource, this.owner) ? 1 : 0);
        const maxOtherOwners = String(resource).startsWith('shared:') ? 2 : 1;
        if (otherOwners >= maxOtherOwners || occupied.get(context.world,context.dimension,resource,this.owner,now)) {
          this.db.exec('ROLLBACK'); return null;
        }
      }
      const insert = this.db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?)');
      for (const resource of unique) insert.run(context.world, context.dimension, resource, this.owner, token, now + ttl);
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

module.exports = { SwarmReservations, cell };
