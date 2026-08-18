// GET /api/export-config — which export renderer the deployment prefers.
//
// FS_EXPORT_RENDERER is an SWA application setting: 'engine' (default, the
// vendored fs-render) or 'local' (the frozen pre-cutover renderers in
// legacy-render.js — the repair fallback). The client reads this once at
// boot; a per-browser localStorage override and the export endpoint's
// ?renderer= query parameter both win over it for their own scope.
module.exports = async function (context) {
  const v = String(process.env.FS_EXPORT_RENDERER || '').toLowerCase();
  context.res = {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ renderer: v === 'local' ? 'local' : 'engine' })
  };
};
