// What a full budget save (PUT /api/budget/{id} with {meta, doc}) must refuse
// BEFORE it writes, decided from what the database already holds rather than
// from the request being judged.
//
// Pure and dependency-free apart from the guard-rail module, so
// test/mock-api.js runs exactly these rules instead of a copy of them — the
// same reason it requires the real guardrails.js and user-settings contract.
// The SQL that fetches the stored row and the caller's role stays in
// api/budget/index.js; everything that DECIDES lives here.
const FSGuardrails = require('./guardrails');

const json = (status, body) => ({ status, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) });

/* ---- 1. The Budget ID cannot change under an existing budget (D13).

   The editor sends the id the budget was opened (or first saved) as in
   meta.originalId. An UPDATE whose route id differs from it is a budget
   trying to move onto another id — and an update to an occupied id would
   overwrite that budget and version the replacement as its next revision,
   because only a create checks whether the id is taken. A create is exempt:
   it has its own occupied-id guard, and New Budget / Add Alternate are the
   legitimate ways to write under a new id. A save without originalId (an
   older client, a script) behaves exactly as before. */
function idChangeRefusal(meta, routeId, wantsCreate) {
  if (wantsCreate || !meta) return null;
  const orig = typeof meta.originalId === 'string' ? meta.originalId.trim().toUpperCase() : '';
  if (!orig || orig === routeId) return null;
  return json(409, { error: 'budget_id_changed', field: 'projectId', originalId: orig,
    message: 'This budget is ' + orig + '. A budget’s ID is fixed once it is saved, so it '
      + 'cannot be saved as ' + routeId + ' — nothing was saved. To price it another way, '
      + 'use Add Alternate on its project.' });
}

/* ---- 2. Which rail table judges the save (D7).

   doc.guardrails and doc.type arrive in the very request being judged, so the
   server reads neither. The table is DEFAULT_POLICY for the type the row will
   CARRY — meta.type, which is what the save writes to dbo.Budgets.Type.

   Only one table is laxer than the rest: Blank (two rails instead of
   fourteen). Every other type, including a template-defined one, is judged as
   Multifamily. So the rule only has to guard the way INTO Blank:

   - A budget is Blank only if it was CREATED Blank. In the app the type is
     chosen once, in the New Budget dialog (Blank Budget, or a template's
     budgetType) — no input changes it afterwards — so a first save (no row
     yet) may say Blank.
   - An existing budget whose stored Type is not Blank cannot become Blank:
     that save is refused, because a plain save reaching the Blank table would
     switch thirteen rails off. Allowing it once would also make the NEXT save
     read Blank from the row.
   - Any other type change is allowed (Blank → Multifamily, Multifamily →
     Commercial): none of them can loosen the rails. */
const BLANK = 'Blank';
const typeOf = t => (typeof t === 'string' && t.trim()) ? t.trim() : 'Multifamily';

function railPolicy({ exists, storedType, submittedType }) {
  const type = typeOf(submittedType);
  if (type === BLANK && exists && typeOf(storedType) !== BLANK) {
    return { refusal: json(409, { error: 'type_change_not_allowed', field: 'type',
      message: 'A budget is Blank only when it is created as one, and this one was not. Nothing was saved.' }) };
  }
  return { type, policy: FSGuardrails.policyForType(type) };
}

/* ---- 3. Who may record a guard-rail override (D7).

   An acknowledgement downgrades a blocking rail to a warning, so recording
   one is the decision the rail exists to force. The UI offers it only to a
   director or super admin (canAckGuardrail() in app/index.html: dbo.Users
   AppRole director/super_admin, or the platform super_admin role); the save
   applies the same rule to every NEW acknowledgement — one whose rail is not
   acknowledged in the stored document, or is with a different reason.
   Acknowledgements already stored stay valid whoever saves next, so an old
   budget keeps saving. Only acknowledgements the evaluator would honour (a
   string id and a non-blank reason) count; anything else is inert. */
const OVERRIDE_ROLES = new Set(['director', 'super_admin']);
const honoured = a => !!(a && typeof a.id === 'string'
  && typeof a.reason === 'string' && a.reason.trim());
const acksOf = d => (d && Array.isArray(d.guardrailAcks) ? d.guardrailAcks : []).filter(honoured);

function newAcks(storedDoc, doc) {
  const had = new Set(acksOf(storedDoc).map(a => a.id + '\u0000' + a.reason));
  return acksOf(doc).filter(a => !had.has(a.id + '\u0000' + a.reason)).map(a => a.id);
}

/* appRoleColumn false means sql/migrate_roles_and_ownership.sql has not run:
   every account reads as the default role then, the UI cannot tell a director
   from anyone else either, and refusing would make overrides impossible for
   everybody. So the pre-migration behaviour stands — any signed-in save may
   record one — until the column exists. */
function canOverride({ appRoleColumn, appRole, userRoles }) {
  if (!appRoleColumn) return true;
  if (Array.isArray(userRoles) && userRoles.includes('super_admin')) return true;
  return OVERRIDE_ROLES.has(appRole);
}

function overrideRefusal(ids) {
  return json(403, { error: 'override_not_allowed', rails: ids,
    message: 'Only a director or super admin can record a guard-rail override. Nothing was saved '
      + '— bring the value back into range, or ask a director to record the override.' });
}

module.exports = { idChangeRefusal, railPolicy, newAcks, canOverride, overrideRefusal,
                   OVERRIDE_ROLES };
