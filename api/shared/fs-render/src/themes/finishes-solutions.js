'use strict';

/**
 * finishes-solutions theme — brand tokens as data. A future app supplies its
 * own object of this shape and gets its own branding with zero renderer
 * changes. Values sourced from the design-skill tokens and the budgeting
 * suite's proven export palette; change deliberately, note in CHANGELOG.
 */
module.exports = {
  name: 'finishes-solutions',
  version: 1,
  palette: {
    ink900: '#16191A', ink700: '#353B3D', ink600: '#4E5456', ink500: '#6B7174',
    ink200: '#DDE1E2', ink100: '#F1F3F3',
    green: '#006527', green50: '#F1F8F4',
    hl: '#D8F3E0',            // row-highlight tint
    tileLabel: '#9BA1A3',      // kpi tile label on dark
    white: '#FFFFFF',
  },
  fonts: {
    display: 'Montserrat',     // registered in both runtimes; engine/fonts ships the TTFs for Node
  },
  band: {                       // workbook brand band (rows 1–2)
    productLine: 'FINISHES SOLUTIONS',
    row1Fill: '#16191A',
    row2Fill: '#006527',
  },
  footer: {
    left: 'Finishes Solutions — Building a Future Together',
    showPageNumbers: true,
  },
};
