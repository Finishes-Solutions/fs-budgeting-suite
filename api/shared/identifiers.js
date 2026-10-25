/* Row identifiers inside stored documents — the one rule for what they may be.

   A budget line's lineId and an impact-fee row's rowId / feeId are rendered by
   app/index.html into attributes (data-k focus keys, data-id) that the page's
   handlers read back. An id is data the page trusts as a key, so it must never
   be able to carry markup or script: a lineId of `x" autofocus onfocus="…` used
   to break out of its attribute and run as whoever opened the budget. Escaping
   at render is one layer; refusing the id at the door is the other, and this is
   that door.

   The pattern is what every generator already produces: crypto.randomUUID()
   (hex and hyphens), the `l-<base36>-<base36>` fallback, the `tpl-…` template
   ids and schedule rows like `m-4-250`. 64 is SovLines.LineKey's width.
   app/index.html carries the same pattern as ROW_ID_RX so the client can
   regenerate a poisoned id on load; change them together. */
const ROW_ID_RX = /^[A-Za-z0-9_-]{1,64}$/;

// Absent is fine (the client mints one on load); present must be a safe string.
const isAbsent = v => v === undefined || v === null || v === '';
const isSafeRowId = v => typeof v === 'string' && ROW_ID_RX.test(v);

function firstBad(list, key, where) {
  if (!Array.isArray(list)) return null;
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    if (x && typeof x === 'object' && !isAbsent(x[key]) && !isSafeRowId(x[key]))
      return where + '[' + i + '].' + key;
  }
  return null;
}

/* The budget document's row ids. Returns the path of the first bad one, or null. */
function budgetIdentifierProblem(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const f = doc.impactFees && typeof doc.impactFees === 'object' ? doc.impactFees : {};
  return firstBad(doc.lines, 'lineId', 'lines')
    || firstBad(f.meters, 'rowId', 'impactFees.meters')
    // Each meter selection's own id (a project can carry the same size twice)
    // is rendered into the same attributes as rowId.
    || firstBad(f.meters, 'id', 'impactFees.meters')
    || firstBad(f.manual, 'rowId', 'impactFees.manual')
    || firstBad(f.extras, 'feeId', 'impactFees.extras')
    // The estimate engine's ids (app/budget-v2.js renders them into data-*
    // attributes the same way lines are).
    || engineIdentifierProblem(doc.engine);
}

function engineIdentifierProblem(e) {
  if (!e || typeof e !== 'object') return null;
  const bad = firstBad(e.components, 'id', 'engine.components') || firstBad(e.phases, 'id', 'engine.phases')
    || firstBad(e.shared, 'id', 'engine.shared') || firstBad(e.scenarios, 'id', 'engine.scenarios');
  if (bad) return bad;
  const comps = Array.isArray(e.components) ? e.components : [];
  for (let i = 0; i < comps.length; i++) {
    const b = comps[i] && firstBad(comps[i].blocks, 'id', 'engine.components[' + i + '].blocks');
    if (b) return b;
  }
  return null;
}

/* A fee schedule's row ids, which budgets reference and the Impact Fees step
   renders. Returns the path of the first bad one, or null. */
function scheduleIdentifierProblem(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return firstBad(doc.meters, 'rowId', 'meters') || firstBad(doc.fees, 'feeId', 'fees');
}

const IDENTIFIER_RULE = 'letters, digits, hyphens and underscores, at most 64 characters';

module.exports = { ROW_ID_RX, isSafeRowId, budgetIdentifierProblem, scheduleIdentifierProblem,
  IDENTIFIER_RULE };
