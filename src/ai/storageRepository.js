class StorageRepository {
  constructor(memory, options = {}) {
    if (!memory?.db) throw new TypeError('StorageRepository membutuhkan SharedWorldMemory.');
    this.db = memory.db;
    this.historyLimit = Number.isInteger(options.historyLimit) ? options.historyLimit : 50;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS storage_containers (
        world TEXT NOT NULL, dimension TEXT NOT NULL,
        x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
        observer TEXT NOT NULL, observedAt INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (world, dimension, x, y, z)
      );
      CREATE TABLE IF NOT EXISTS storage_container_items (
        world TEXT NOT NULL, dimension TEXT NOT NULL,
        x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
        slotIndex INTEGER NOT NULL, itemJson TEXT NOT NULL,
        PRIMARY KEY (world, dimension, x, y, z, slotIndex),
        FOREIGN KEY (world, dimension, x, y, z)
          REFERENCES storage_containers(world, dimension, x, y, z) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS storage_misplaced_items (
        world TEXT NOT NULL, dimension TEXT NOT NULL,
        x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
        itemIndex INTEGER NOT NULL, itemJson TEXT NOT NULL,
        PRIMARY KEY (world, dimension, x, y, z, itemIndex),
        FOREIGN KEY (world, dimension, x, y, z)
          REFERENCES storage_containers(world, dimension, x, y, z) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS storage_compliance_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        world TEXT NOT NULL, dimension TEXT NOT NULL,
        botName TEXT NOT NULL, eventJson TEXT NOT NULL, observedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS storage_compliance_context
        ON storage_compliance_history(world, dimension, observedAt DESC);
      CREATE TABLE IF NOT EXISTS storage_assignments (
        world TEXT NOT NULL, dimension TEXT NOT NULL,
        itemName TEXT NOT NULL, chestKey TEXT NOT NULL,
        observer TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (world, dimension, itemName)
      );
    `);
    this.upsertContainer = this.db.prepare(`INSERT INTO storage_containers
      (world, dimension, x, y, z, observer, observedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(world, dimension, x, y, z) DO UPDATE SET
        observer=excluded.observer, observedAt=excluded.observedAt,
        revision=storage_containers.revision+1
      WHERE excluded.observedAt >= storage_containers.observedAt`);
    this.deleteItems = this.db.prepare(`DELETE FROM storage_container_items
      WHERE world=? AND dimension=? AND x=? AND y=? AND z=?`);
    this.deleteMisplaced = this.db.prepare(`DELETE FROM storage_misplaced_items
      WHERE world=? AND dimension=? AND x=? AND y=? AND z=?`);
    this.insertItem = this.db.prepare(`INSERT INTO storage_container_items
      (world, dimension, x, y, z, slotIndex, itemJson) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.insertMisplaced = this.db.prepare(`INSERT INTO storage_misplaced_items
      (world, dimension, x, y, z, itemIndex, itemJson) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  }

  validateContext(context) {
    if (!context?.world || !context?.dimension) throw new Error('Konteks dunia gudang tidak valid.');
    return { world: String(context.world), dimension: String(context.dimension) };
  }

  saveChestSnapshot(context, snapshot, observer = 'StorageWorker') {
    const { world, dimension } = this.validateContext(context);
    const position = snapshot?.containerPosition || snapshot?.position;
    if (!position || !['x', 'y', 'z'].every(axis => Number.isInteger(position[axis]))) {
      throw new Error('Posisi snapshot peti tidak valid.');
    }
    const observedAt = Number(snapshot.timestamp || Date.now());
    if (!Number.isSafeInteger(observedAt)) throw new Error('Waktu snapshot peti tidak valid.');
    const key = [world, dimension, position.x, position.y, position.z];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.upsertContainer.run(...key, String(observer), observedAt);
      if (Number(result.changes) === 0) {
        this.db.exec('COMMIT');
        return false;
      }
      this.deleteItems.run(...key);
      this.deleteMisplaced.run(...key);
      (snapshot.items || []).forEach((item, index) => {
        const slotIndex = Number.isInteger(item?.slot) ? item.slot : index;
        this.insertItem.run(...key, slotIndex, JSON.stringify(item));
      });
      (snapshot.misplaced || []).forEach((item, index) => {
        this.insertMisplaced.run(...key, index, JSON.stringify(item));
      });
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listChestSnapshots(context) {
    const { world, dimension } = this.validateContext(context);
    const containers = this.db.prepare(`SELECT x,y,z,observer,observedAt,revision
      FROM storage_containers WHERE world=? AND dimension=? ORDER BY y,x,z`).all(world, dimension);
    const getItems = this.db.prepare(`SELECT itemJson FROM storage_container_items
      WHERE world=? AND dimension=? AND x=? AND y=? AND z=? ORDER BY slotIndex`);
    const getMisplaced = this.db.prepare(`SELECT itemJson FROM storage_misplaced_items
      WHERE world=? AND dimension=? AND x=? AND y=? AND z=? ORDER BY itemIndex`);
    return containers.map(row => {
      const key = [world, dimension, row.x, row.y, row.z];
      return {
        position: { x: row.x, y: row.y, z: row.z },
        items: getItems.all(...key).map(item => JSON.parse(item.itemJson)),
        misplaced: getMisplaced.all(...key).map(item => JSON.parse(item.itemJson)),
        timestamp: row.observedAt,
        observer: row.observer,
        revision: row.revision
      };
    });
  }

  recordCompliance(context, entry) {
    const { world, dimension } = this.validateContext(context);
    const observedAt = Number(entry?.timestamp || Date.now());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO storage_compliance_history
        (world,dimension,botName,eventJson,observedAt) VALUES (?,?,?,?,?)`)
        .run(world, dimension, String(entry?.botName || 'StorageWorker'), JSON.stringify(entry), observedAt);
      this.db.prepare(`DELETE FROM storage_compliance_history WHERE world=? AND dimension=? AND id NOT IN (
        SELECT id FROM storage_compliance_history WHERE world=? AND dimension=?
        ORDER BY observedAt DESC,id DESC LIMIT ?
      )`).run(world, dimension, world, dimension, this.historyLimit);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listCompliance(context) {
    const { world, dimension } = this.validateContext(context);
    return this.db.prepare(`SELECT eventJson FROM storage_compliance_history
      WHERE world=? AND dimension=? ORDER BY observedAt DESC,id DESC LIMIT ?`)
      .all(world, dimension, this.historyLimit).map(row => JSON.parse(row.eventJson));
  }

  upsertAssignments(context, assignments, observer = 'StorageWorker', updatedAt = Date.now()) {
    const { world, dimension } = this.validateContext(context);
    const entries = Object.entries(assignments || {}).filter(([itemName, chestKey]) => itemName && chestKey);
    const put = this.db.prepare(`INSERT INTO storage_assignments
      (world,dimension,itemName,chestKey,observer,updatedAt) VALUES (?,?,?,?,?,?)
      ON CONFLICT(world,dimension,itemName) DO UPDATE SET
        chestKey=excluded.chestKey,observer=excluded.observer,updatedAt=excluded.updatedAt
      WHERE excluded.updatedAt >= storage_assignments.updatedAt`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [itemName, chestKey] of entries) {
        put.run(world, dimension, itemName, String(chestKey), String(observer), updatedAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return entries.length;
  }

  getAssignments(context) {
    const { world, dimension } = this.validateContext(context);
    return Object.fromEntries(this.db.prepare(`SELECT itemName,chestKey FROM storage_assignments
      WHERE world=? AND dimension=? ORDER BY itemName`).all(world, dimension)
      .map(row => [row.itemName, row.chestKey]));
  }
}

module.exports = { StorageRepository };
