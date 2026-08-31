// Entity Master — the structured list of legal entities and the six Finishes
// operating companies. Master data: rows deactivate (IsActive) rather than
// delete, because a project or contract may reference them.
//
// Reads ride GET /api/budgets?scope=entities (an endpoint that already
// deploys); writes ride PUT /api/user-settings?scope=entities. A new
// api/<name>/ folder is not reliably picked up by the deployed host, so there
// is no api/entities/ — the scope is the surface, and the in-function role
// check is its only gate.
const { sql } = require('./db');
const { features } = require('./schema');

function jsonRes(status, body) {
  return { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body) };
}

function slugify(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/\bllc\b|\binc\b|\bltd\b|\bl\.l\.c\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function shape(x) {
  return {
    entityId: Number(x.EntityId), entityKey: x.EntityKey,
    legalName: x.LegalName || '', displayName: x.DisplayName || '',
    entityType: x.EntityType || '', address: x.Address || '',
    isFinishesCompany: !!x.IsFinishesCompany, isActive: !!x.IsActive
  };
}

async function listEntities(pool, opts) {
  const f = await features(pool);
  if (!f.entitiesTable) return { available: false, entities: [] };
  const includeInactive = opts && opts.includeInactive;
  const r = await pool.request().query(
    `SELECT EntityId, EntityKey, LegalName, DisplayName, EntityType, Address, IsFinishesCompany, IsActive
     FROM dbo.Entities
     ${includeInactive ? '' : 'WHERE IsActive = 1'}
     ORDER BY IsFinishesCompany DESC, DisplayName`);
  return { available: true, entities: r.recordset.map(shape) };
}

// Create or update one entity. entityId present → update; absent → create with
// a slug minted from the display name (uniqueness-checked). The six seeded
// Finishes companies refuse deactivation and key edits — template allocation
// rules point at their keys.
async function upsertEntity(pool, body, principal) {
  const f = await features(pool);
  if (!f.entitiesTable) return jsonRes(503, { error: 'not_migrated',
    message: 'The Entity Master is not available until sql/migrate_entities.sql has run.' });
  body = body || {};

  const legalName = String(body.legalName == null ? '' : body.legalName).trim();
  const displayName = String(body.displayName == null ? '' : body.displayName).trim() || legalName;
  if (!legalName) return jsonRes(400, { error: 'bad_request', field: 'legalName', message: 'Legal Name is required.' });
  const entityType = String(body.entityType == null ? '' : body.entityType).trim().slice(0, 50) || 'LLC';
  const address = String(body.address == null ? '' : body.address).trim().slice(0, 300);
  const isActive = body.isActive === undefined ? true : !!body.isActive;

  const cuid = principal ? (principal.userId || null) : null;
  const cuname = principal ? (principal.userDetails || null) : null;

  if (body.entityId !== undefined && body.entityId !== null && body.entityId !== '') {
    const id = Number(body.entityId);
    if (!(Number.isInteger(id) && id > 0)) return jsonRes(400, { error: 'bad_request', message: 'Invalid entity id.' });
    const cur = await pool.request().input('id', sql.Int, id)
      .query('SELECT EntityId, EntityKey, IsFinishesCompany FROM dbo.Entities WHERE EntityId = @id');
    if (!cur.recordset.length) return jsonRes(404, { error: 'not_found', message: 'Entity not found.' });
    // A seeded Finishes company must stay active — allocation rules name its key.
    if (cur.recordset[0].IsFinishesCompany && !isActive)
      return jsonRes(400, { error: 'protected_entity',
        message: 'A Finishes company cannot be deactivated — it participates in contracts.' });
    await pool.request()
      .input('id', sql.Int, id)
      .input('legal', sql.NVarChar(300), legalName.slice(0, 300))
      .input('disp', sql.NVarChar(200), displayName.slice(0, 200))
      .input('type', sql.NVarChar(50), entityType)
      .input('addr', sql.NVarChar(300), address)
      .input('active', sql.Bit, isActive)
      .query(`UPDATE dbo.Entities
                SET LegalName = @legal, DisplayName = @disp, EntityType = @type,
                    Address = @addr, IsActive = @active, UpdatedAt = SYSUTCDATETIME()
              WHERE EntityId = @id`);
    const after = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM dbo.Entities WHERE EntityId = @id');
    return jsonRes(200, { ok: true, created: false, entity: shape(after.recordset[0]) });
  }

  // Create. Mint a unique slug from the display name.
  let base = slugify(displayName) || slugify(legalName) || 'entity';
  let entityKey = base, n = 2;
  // The unique index is the real guard; this loop just picks a friendly suffix.
  /* eslint-disable no-await-in-loop */
  while (true) {
    const clash = await pool.request().input('k', sql.VarChar(64), entityKey)
      .query('SELECT 1 AS Found FROM dbo.Entities WHERE EntityKey = @k');
    if (!clash.recordset.length) break;
    entityKey = base + '-' + n; n++;
    if (n > 999) return jsonRes(409, { error: 'entity_key_taken', message: 'Could not mint a unique key.' });
  }
  /* eslint-enable no-await-in-loop */
  const ins = await pool.request()
    .input('key', sql.VarChar(64), entityKey)
    .input('legal', sql.NVarChar(300), legalName.slice(0, 300))
    .input('disp', sql.NVarChar(200), displayName.slice(0, 200))
    .input('type', sql.NVarChar(50), entityType)
    .input('addr', sql.NVarChar(300), address)
    .input('active', sql.Bit, isActive)
    .input('cuid', sql.NVarChar(128), cuid)
    .input('cuname', sql.NVarChar(200), cuname)
    .query(`INSERT INTO dbo.Entities (EntityKey, LegalName, DisplayName, EntityType, Address, IsFinishesCompany, IsActive, CreatedById, CreatedByName)
            OUTPUT INSERTED.*
            VALUES (@key, @legal, @disp, @type, @addr, 0, @active, @cuid, @cuname)`);
  return jsonRes(201, { ok: true, created: true, entity: shape(ins.recordset[0]) });
}

module.exports = { listEntities, upsertEntity, slugify, shape, jsonRes };
