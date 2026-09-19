const {randomUUID}=require('node:crypto');
const {connectedComponents}=require('./structureGeometry');

function kindOf(name) {
  if(['chest','barrel','trapped_chest'].includes(name)||name.endsWith('shulker_box'))return 'storage';
  if(['farmland','wheat','carrots','potatoes','beetroots','sugar_cane','bamboo','cactus','nether_wart','melon','pumpkin'].includes(name))return 'cultivation';
  if(['furnace','blast_furnace','smoker'].includes(name))return 'smelting';
  if(['crafting_table','anvil','smithing_table','stonecutter','loom','lectern','composter'].includes(name))return 'workstation';
  if(name.endsWith('rail'))return 'railway';
  if(['redstone_wire','repeater','comparator','piston','sticky_piston'].includes(name))return 'redstone';
  if(['nether_portal','end_portal'].includes(name))return 'portal';
  if(/_planks$|_bricks$|glass|_door$|_bed$/.test(name))return 'building';
  return null;
}

class StructureRegistry {
  constructor(memory) {
    this.db=memory.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS structures (
      id TEXT PRIMARY KEY,world TEXT NOT NULL,dimension TEXT NOT NULL,kind TEXT NOT NULL,
      label TEXT,revision INTEGER NOT NULL DEFAULT 1,updatedAt INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS structure_voxels (
      world TEXT NOT NULL,dimension TEXT NOT NULL,x INTEGER NOT NULL,y INTEGER NOT NULL,z INTEGER NOT NULL,
      id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(world,dimension,x,y,z)
    ); CREATE INDEX IF NOT EXISTS structure_cells ON structure_voxels(id);`);
  }

  observe(context, blocks) {
    const affected=new Set();
    const now=Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const b of blocks.filter(Boolean)) {
        const {x,y,z}=b.position;
        if(context.observedAt!==undefined) {
          const latest=this.db.prepare('SELECT observedAt,name FROM blocks WHERE world=? AND dimension=? AND x=? AND y=? AND z=?').get(context.world,context.dimension,x,y,z);
          if(latest && (latest.observedAt>context.observedAt || latest.name!==b.name))continue;
        }
        const previous=this.db.prepare('SELECT id,name FROM structure_voxels WHERE world=? AND dimension=? AND x=? AND y=? AND z=?')
          .get(context.world,context.dimension,x,y,z);
        if(previous?.name===b.name)continue;
        if(previous) {
          affected.add(previous.id);
          this.db.prepare('DELETE FROM structure_voxels WHERE world=? AND dimension=? AND x=? AND y=? AND z=?').run(context.world,context.dimension,x,y,z);
        }
        const kind=kindOf(b.name);
        if(!kind)continue;
        const neighbours=this.db.prepare(`SELECT DISTINCT s.id FROM structures s JOIN structure_voxels v ON s.id=v.id
          WHERE v.world=? AND v.dimension=? AND s.kind=? AND v.x BETWEEN ? AND ? AND v.y BETWEEN ? AND ? AND v.z BETWEEN ? AND ?
          AND ABS(v.x-?)+ABS(v.y-?)+ABS(v.z-?)=1 ORDER BY s.label IS NULL,s.updatedAt,s.id`)
          .all(context.world,context.dimension,kind,x-1,x+1,y-1,y+1,z-1,z+1,x,y,z);
        const id=neighbours[0]?.id||randomUUID();
        this.db.prepare('INSERT OR IGNORE INTO structures(id,world,dimension,kind,updatedAt) VALUES (?,?,?,?,?)').run(id,context.world,context.dimension,kind,now);
        for(const other of neighbours.slice(1)) {
          this.db.prepare('UPDATE structure_voxels SET id=? WHERE id=?').run(id,other.id);
          affected.add(other.id);
        }
        this.db.prepare('INSERT INTO structure_voxels VALUES (?,?,?,?,?,?,?)').run(context.world,context.dimension,x,y,z,id,b.name);
        affected.add(id);
      }
      // Penghapusan blok penghubung dapat membelah komponen; jangan menyimpan kotak gabungan palsu.
      for(const id of affected) {
        const row=this.db.prepare('SELECT * FROM structures WHERE id=?').get(id);
        const cells=this.db.prepare('SELECT x,y,z,name FROM structure_voxels WHERE id=?').all(id);
        if(!row)continue;
        const groups=connectedComponents(cells.map(c=>({name:c.name,position:{x:c.x,y:c.y,z:c.z}}))).sort((a,b)=>b.length-a.length);
        for(const group of groups.slice(1)) {
          const child=randomUUID();
          this.db.prepare('INSERT INTO structures(id,world,dimension,kind,updatedAt) VALUES (?,?,?,?,?)').run(child,row.world,row.dimension,row.kind,now);
          for(const b of group)this.db.prepare('UPDATE structure_voxels SET id=? WHERE world=? AND dimension=? AND x=? AND y=? AND z=?')
            .run(child,row.world,row.dimension,b.position.x,b.position.y,b.position.z);
        }
        this.db.prepare('UPDATE structures SET revision=revision+1,updatedAt=? WHERE id=?').run(now,id);
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  list() {
    return this.db.prepare(`SELECT s.*,COUNT(v.id) AS observedVoxels,MIN(v.x) AS minX,MAX(v.x)+1 AS maxX,
      MIN(v.y) AS minY,MAX(v.y)+1 AS maxY,MIN(v.z) AS minZ,MAX(v.z)+1 AS maxZ
      FROM structures s LEFT JOIN structure_voxels v ON s.id=v.id GROUP BY s.id ORDER BY s.updatedAt DESC LIMIT 500`).all();
  }

  label(id,label) {
    if(typeof label!=='string'||label.length>120)throw new Error('Label tidak valid');
    return this.db.prepare('UPDATE structures SET label=?,revision=revision+1 WHERE id=?').run(label,id).changes>0;
  }
}

module.exports={StructureRegistry,kindOf};
