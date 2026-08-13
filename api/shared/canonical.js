// Deterministic JSON canonicalization and SHA-256 content hashing.
//
// A budget save must not create a new immutable version when nothing
// meaningful changed. Comparing the raw request body cannot decide that:
// JSON.stringify key order is insertion order, so re-saving an unmodified
// budget that made a round trip through the database can produce different
// bytes for identical content. Canonicalizing (sorted keys, recursively)
// before hashing makes the comparison depend on content alone.
//
// `updated` is stamped by the frontend on every save whether or not anything
// changed, so it is excluded — otherwise every save would look meaningful.
const crypto = require('crypto');

const VOLATILE_KEYS = new Set(['updated']);

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    // undefined has no JSON representation; treat it as null so a key that is
    // present-but-undefined and a key holding null canonicalize identically.
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value)
    .filter(k => !VOLATILE_KEYS.has(k) && value[k] !== undefined)
    .sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function contentHash(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

// Content comparison that tolerates a differently-computed stored hash. The
// migration hashed the stored Doc text directly (UTF-16, uncanonicalized), so
// baseline rows never match an app-computed hash even when the content is
// identical. Callers fall back to this.
function contentEquals(a, b) {
  return canonical(a) === canonical(b);
}

// Parse a stored Doc column, tolerating malformed rows rather than throwing
// inside a save transaction.
function parseDoc(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

module.exports = { canonical, contentHash, contentEquals, parseDoc, VOLATILE_KEYS };
