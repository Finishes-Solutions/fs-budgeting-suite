// Static Web Apps injects the authenticated principal as a base64 header.
function getPrincipal(req) {
  const header = req.headers['x-ms-client-principal'];
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch (e) { return null; }
}
function hasRole(req, role) {
  const p = getPrincipal(req);
  return !!(p && Array.isArray(p.userRoles) && p.userRoles.includes(role));
}
module.exports = { getPrincipal, hasRole };
