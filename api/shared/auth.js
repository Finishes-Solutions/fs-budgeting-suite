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
  if (!p || !Array.isArray(p.userRoles)) return false;
  if (p.userRoles.includes(role)) return true;
  // super_admin subsumes pricing_admin
  if (role === 'pricing_admin' && p.userRoles.includes('super_admin')) return true;
  return false;
}
function isSuperAdmin(req) {
  const p = getPrincipal(req);
  return !!(p && Array.isArray(p.userRoles) && p.userRoles.includes('super_admin'));
}
module.exports = { getPrincipal, hasRole, isSuperAdmin };
