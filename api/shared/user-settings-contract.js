// The per-user settings CONTRACT — what the client may store and what the
// stored document is guaranteed to look like. Dependency-free on purpose:
// api/shared/users.js applies it against SQL, and test/mock-api.js applies
// the very same module, so validation cannot drift between the two.
//
// Unknown keys are dropped and bad values fall back to the default, so a
// stored document is always safe to apply blindly at boot. New settings are
// additive keys here — never a schema migration.
const THEMES = ['light', 'dark'];
const TIME_FORMATS = ['12h', '24h'];
// Named accents ship curated light+dark scales; a #rrggbb value is a custom
// accent whose scale the client derives from the picked color.
const ACCENTS = ['green', 'blue', 'violet', 'graphite', 'red', 'orange'];
// View settings: three options each — comfortable and compact are the list
// view at two densities; cards is the card view — and each SECTION keeps its
// own choice, so budgets can be a list while analyses are cards. (This
// replaced the earlier homeView + tableDensity pair — sanitize maps them.)
// Projects joined budgets and analyses here: three sections, three choices.
const LIST_VIEWS = ['comfortable', 'compact', 'cards'];
// Theme packs are alternate visual PRESENTATIONS of the same product — paint
// only, scoped in CSS to html[data-skin=<pack>]. 'default' is the Finishes
// Solutions appearance. Packs are a super_admin preview: the client decides by
// role whether to apply a stored pack, so an account that loses the role stops
// seeing one without its setting being rewritten.
const THEME_PACKS = ['default', 'ramp'];
const HEX_RX = /^#[0-9a-fA-F]{6}$/;
// Favorited records. Three lists of ids — budget ids, analysis GUIDs and
// project ids — so a favorite follows the account to any signed-in browser.
// Bounded on both count and id length: this document is stored per user and
// read on every bootstrap, and an unbounded list would let one account bloat it.
//
// This was `pinned` (budgets + analyses only). sanitizeSettings() lifts a
// stored legacy document, the same way it already lifts homeView/tableDensity
// into budgetView — so nothing anyone had starred is lost and no migration runs.
const FAV_MAX = 50;
const FAV_ID_MAX = 64;

const DEFAULT_SETTINGS = {
  theme: 'light',
  themePack: 'default',
  timeFormat: '12h',
  accentColor: 'green',
  avatarColor: null,          // null = the app default (accent-colored)
  budgetView: 'comfortable',
  analysisView: 'comfortable',
  projectView: 'comfortable',
  // The first-run welcome has been dismissed. Per ACCOUNT, not per browser, so
  // a returning user is not welcomed again on a second machine, and it rides
  // the settings document the client already loads at boot.
  welcomeSeen: false,
  rememberExport: false,
  exportOptions: {},          // { budget: {..bools}, analysis: {..bools} }
  favorites: { budget: [], analysis: [], project: [] }
};

function pickEnum(v, allowed, dflt) { return allowed.includes(v) ? v : dflt; }

// Legacy documents stored one homeView ('list'|'cards') + tableDensity pair.
function legacyView(s) {
  if (LIST_VIEWS.includes(s.listView)) return s.listView;   // brief intermediate shape
  if (s.homeView === 'cards') return 'cards';
  return s.tableDensity === 'compact' ? 'compact' : 'comfortable';
}

function cleanBoolMap(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v).slice(0, 20)) {
      if (typeof k === 'string' && k.length <= 40 && typeof v[k] === 'boolean') out[k] = v[k];
    }
  }
  return out;
}

// A favorites list: strings only, trimmed, de-duplicated, order preserved (most
// recently favorited first), and capped. Anything else is dropped rather than
// stored, so the document a client gets back is always safe to render.
function cleanIdList(v) {
  const out = [];
  const seen = Object.create(null);
  if (Array.isArray(v)) {
    for (const raw of v) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (!id || id.length > FAV_ID_MAX || seen[id]) continue;
      seen[id] = 1;
      out.push(id);
      if (out.length >= FAV_MAX) break;
    }
  }
  return out;
}

function sanitizeSettings(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ex = s.exportOptions && typeof s.exportOptions === 'object' && !Array.isArray(s.exportOptions)
    ? s.exportOptions : {};
  // `favorites` wins; a legacy `pinned` document is read when it does not exist.
  const favSrc = s.favorites && typeof s.favorites === 'object' && !Array.isArray(s.favorites) ? s.favorites
    : (s.pinned && typeof s.pinned === 'object' && !Array.isArray(s.pinned) ? s.pinned : {});
  return {
    theme: pickEnum(s.theme, THEMES, DEFAULT_SETTINGS.theme),
    themePack: pickEnum(s.themePack, THEME_PACKS, DEFAULT_SETTINGS.themePack),
    timeFormat: pickEnum(s.timeFormat, TIME_FORMATS, DEFAULT_SETTINGS.timeFormat),
    accentColor: (typeof s.accentColor === 'string' && HEX_RX.test(s.accentColor))
      ? s.accentColor.toLowerCase()
      : pickEnum(s.accentColor, ACCENTS, DEFAULT_SETTINGS.accentColor),
    avatarColor: typeof s.avatarColor === 'string' && HEX_RX.test(s.avatarColor) ? s.avatarColor : null,
    budgetView: LIST_VIEWS.includes(s.budgetView) ? s.budgetView : legacyView(s),
    analysisView: LIST_VIEWS.includes(s.analysisView) ? s.analysisView : legacyView(s),
    projectView: LIST_VIEWS.includes(s.projectView) ? s.projectView : legacyView(s),
    welcomeSeen: s.welcomeSeen === true,
    rememberExport: s.rememberExport === true,
    exportOptions: { budget: cleanBoolMap(ex.budget), analysis: cleanBoolMap(ex.analysis) },
    favorites: { budget: cleanIdList(favSrc.budget), analysis: cleanIdList(favSrc.analysis),
                 project: cleanIdList(favSrc.project) }
  };
}

// Email is deliberately NOT here: it is locked to the signed-in account
// (the platform's userDetails) and maintained server-side, never client-set.
function sanitizeProfile(body) {
  const b = body && typeof body === 'object' ? body : {};
  const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
  return {
    displayName: str(b.displayName, 200),
    phone: str(b.phone, 40)
  };
}

// Activity events the CLIENT may report directly (browser-side exports never
// touch the API). Everything else is recorded server-side by the endpoint
// that did the work.
const CLIENT_EVENTS = new Set(['export_pdf', 'export_xlsx', 'export_csv', 'export_print']);

module.exports = { DEFAULT_SETTINGS, CLIENT_EVENTS, sanitizeSettings, sanitizeProfile };
