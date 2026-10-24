// Sample projects for docs/sample-output (Phase 6). Each is an engine project
// exactly as the Inputs page would save it, plus the pro forma assumptions a
// user would type on the analysis (exit cap). COSTS come from the engine and
// the research bundle. REVENUE, LAND PRICES and EXIT CAPS here are illustrative
// user inputs — not research — chosen only so every sample can run through
// the pro forma; they are labelled that way in docs/sample-output/README.md.
'use strict';

const ph = (id, name, startMonth, extra) => Object.assign({ id, name, startMonth, months: null, drawCurve: 's',
  financing: { enabled: true, ltc: null, rate: null, feePct: null } }, extra || {});
const comp = (id, typeId, size, o) => Object.assign({ id, typeId, name: null, phaseId: 'p1', size, sf: null, acres: null,
  quality: 'standard', baseline: { price: null, basis: 'national' }, items: {}, blocks: [], contingency: {}, revenue: null }, o || {});
const project = (o) => Object.assign({ schema: 1, mode: 'quick', location: { region: 'US' }, startMonth: '2027-03',
  settings: {}, land: { mode: 'amount', value: 0 }, phases: [ph('p1', 'Phase 1', null)], components: [], shared: [],
  overrides: {}, scenarios: [] }, o);

module.exports = [
  { id: '01-garden-multifamily', name: 'Cedar Hollow — garden multifamily', address: 'Katy, TX', exitCap: 0.0575,
    project: project({ location: { region: 'TX-Houston' }, land: { mode: 'amount', value: 4800000 },
      components: [comp('c1', 'garden-multifamily', 240, { name: 'Cedar Hollow apartments',
        revenue: { mode: 'perUnitMonth', rate: 1800, otherIncome: 260000, vacancy: 0.06, expenseRatio: 0.40 } })] }) },

  { id: '02-podium-mixed-use-2-phase', name: 'Station Square — podium mixed-use, 2 phases', address: 'Austin, TX', exitCap: 0.055,
    project: project({ mode: 'mixed', location: { region: 'TX-Austin' }, startMonth: '2027-01',
      land: { mode: 'amount', value: 9500000, acres: 3.2 },
      phases: [ph('p1', 'Phase 1 — podium + residential', '2027-01'), ph('p2', 'Phase 2 — retail fit-out', null)],
      components: [
        comp('res', 'podium-multifamily', 280, { name: 'Residential over podium', phaseId: 'p1',
          revenue: { mode: 'perUnitMonth', rate: 2550, otherIncome: 400000, vacancy: 0.06, expenseRatio: 0.38 } }),
        comp('ret', 'retail-strip', 22000, { name: 'Ground-floor retail', phaseId: 'p2', acres: 0,
          items: {}, revenue: { mode: 'perSFYear', rate: 38, vacancy: 0.08, expenseRatio: 0.15 } })],
      shared: [{ id: 'garage', name: 'Structured parking (shared)', itemId: 'parking-structured-above', qty: 420, phaseId: 'p1',
        allocation: { method: 'sf' } }] }) },

  { id: '03-select-service-hotel', name: 'Harbor Point — select-service hotel', address: 'Nashville, TN', exitCap: 0.085,
    project: project({ location: { region: 'TN-Nashville' }, land: { mode: 'amount', value: 3200000 },
      components: [comp('c1', 'hotel-select-service', 124, { name: 'Harbor Point hotel',
        revenue: { mode: 'perUnitYear', rate: 64000, otherIncome: 350000, vacancy: 0.27, expenseRatio: 0.64 } })] }) },

  { id: '04-warehouse', name: 'I-20 Logistics Center — bulk warehouse', address: 'Dallas–Fort Worth, TX', exitCap: 0.0575,
    project: project({ location: { region: 'TX-DFW' }, land: { mode: 'perAcre', value: 260000, acres: 24 },
      components: [comp('c1', 'warehouse-distribution', 320000, { name: 'Building A',
        revenue: { mode: 'perSFYear', rate: 7.25, vacancy: 0.05, expenseRatio: 0.08 } })] }) },

  { id: '05-medical-office', name: 'Desert Ridge MOB', address: 'Phoenix, AZ', exitCap: 0.0675,
    project: project({ location: { region: 'AZ-Phoenix' }, land: { mode: 'amount', value: 2600000 },
      components: [comp('c1', 'medical-office', 45000, { name: 'Medical office building',
        revenue: { mode: 'perSFYear', rate: 36, otherIncome: 0, vacancy: 0.07, expenseRatio: 0.06 } })] }) },

  { id: '06-retail-pad-qsr', name: 'Outparcel QSR with drive-thru', address: 'Atlanta, GA', exitCap: 0.0575,
    project: project({ location: { region: 'GA-Atlanta' }, land: { mode: 'amount', value: 1150000 },
      components: [comp('c1', 'retail-pad-qsr', 2800, { name: 'QSR building',
        revenue: { mode: 'annual', rate: 210000, vacancy: 0, expenseRatio: 0.03 } })] }) },

  { id: '07-self-storage', name: 'Bayside Climate Storage', address: 'Tampa, FL', exitCap: 0.0625,
    project: project({ location: { region: 'FL-Tampa' }, land: { mode: 'amount', value: 2400000 },
      components: [comp('c1', 'self-storage-climate', 88000, { name: 'Climate-controlled storage',
        revenue: { mode: 'perUnitYear', rate: 19.5, otherIncome: 90000, vacancy: 0.12, expenseRatio: 0.35 } })] }) },

  { id: '08-office-ti', name: 'Fulton Market office TI', address: 'Chicago, IL', exitCap: 0.07,
    project: project({ location: { region: 'IL-Chicago' },
      components: [comp('c1', 'office-ti', 22000, { name: 'Tenant improvement — floors 6–7' })] }) },

  { id: '09-tiny-home-community', name: 'Cedar Pines tiny home community', address: 'Austin, TX', exitCap: 0.07,
    project: project({ location: { region: 'TX-Austin' }, land: { mode: 'perAcre', value: 95000 },
      components: [comp('c1', 'tiny-home-community', 40, { name: 'Tiny home pads',
        revenue: { mode: 'perUnitMonth', rate: 950, vacancy: 0.08, expenseRatio: 0.35 } })] }) },

  { id: '10-food-truck-park', name: 'Pearl Yard food truck park', address: 'San Antonio, TX', exitCap: 0.08,
    project: project({ location: { region: 'TX-SanAntonio' }, land: { mode: 'amount', value: 850000 },
      components: [comp('c1', 'food-truck-park', 12, { name: 'Food truck park',
        items: { 'grease-interceptor': { on: true } },
        revenue: { mode: 'perUnitMonth', rate: 1800, otherIncome: 240000, vacancy: 0.10, expenseRatio: 0.45 } })] }) },

  { id: '11-rv-resort', name: 'Gulf Breeze RV Resort', address: 'Florida (statewide factor)', exitCap: 0.075,
    project: project({ location: { region: 'FL' }, land: { mode: 'perAcre', value: 60000 },
      components: [comp('c1', 'rv-park-resort', 150, { name: 'RV resort',
        revenue: { mode: 'perUnitYear', rate: 14500, otherIncome: 180000, vacancy: 0.30, expenseRatio: 0.45 } })] }) },

  { id: '12-marina', name: 'Ashley River Marina', address: 'Charleston, SC', exitCap: 0.075,
    project: project({ location: { region: 'SC-Charleston' }, land: { mode: 'amount', value: 3500000 },
      components: [comp('c1', 'marina', 200, { name: 'Marina',
        revenue: { mode: 'perUnitYear', rate: 11500, otherIncome: 450000, vacancy: 0.15, expenseRatio: 0.50 } })] }) },

  { id: '13-data-center', name: 'Ashburn Campus — 24 MW data center', address: 'Northern Virginia (Arlington factor)', exitCap: 0.06,
    project: project({ location: { region: 'VA-Arlington' }, land: { mode: 'amount', value: 30000000 },
      components: [comp('c1', 'data-center', 24000, { name: 'Data hall building 1',
        revenue: { mode: 'perUnitYear', rate: 2100, vacancy: 0.05, expenseRatio: 0.30 } })] }) },

  { id: '14-master-planned-3-phase', name: 'Brazos Crossing — 3-phase master plan', address: 'Fort Worth, TX', exitCap: 0.06,
    project: project({ mode: 'mixed', location: { region: 'TX-FortWorth' }, startMonth: '2027-04',
      land: { mode: 'perAcre', value: 175000, acres: 62 },
      phases: [ph('p1', 'Phase 1 — infrastructure + apartments', '2027-04'), ph('p2', 'Phase 2 — townhomes + retail', null),
        ph('p3', 'Phase 3 — hotel', null)],
      components: [
        comp('mf', 'garden-multifamily', 300, { name: 'Garden apartments', phaseId: 'p1',
          revenue: { mode: 'perUnitMonth', rate: 1750, otherIncome: 320000, vacancy: 0.06, expenseRatio: 0.40 } }),
        comp('th', 'townhomes', 80, { name: 'Rental townhomes', phaseId: 'p2',
          revenue: { mode: 'perUnitMonth', rate: 2650, vacancy: 0.05, expenseRatio: 0.35 } }),
        comp('rt', 'grocery-anchored-center', 65000, { name: 'Grocery-anchored center', phaseId: 'p2',
          revenue: { mode: 'perSFYear', rate: 24, vacancy: 0.07, expenseRatio: 0.15 } }),
        comp('ht', 'hotel-select-service', 110, { name: 'Select-service hotel', phaseId: 'p3',
          revenue: { mode: 'perUnitYear', rate: 52000, otherIncome: 250000, vacancy: 0.30, expenseRatio: 0.66 } })],
      shared: [
        { id: 'roads', name: 'Spine road (private, 2-lane)', itemId: 'private-road', qty: 4200, phaseId: 'p1', allocation: { method: 'sf' } },
        { id: 'detention', name: 'Regional detention', itemId: 'detention-pond', qty: 62, phaseId: 'p1', allocation: { method: 'sf' } },
        { id: 'utils', name: 'Off-site water & sewer extension', itemId: 'offsite-utility-extension', qty: 3800, phaseId: 'p1', allocation: { method: 'units' } },
        { id: 'amen', name: 'Resident amenity center (MF + townhomes)', itemId: 'clubhouse', qty: 6500, phaseId: 'p1',
          allocation: { method: 'manual', shares: { mf: 0.75, th: 0.25 } } }] }) },

  { id: '15-custom-event-retreat', name: 'Hill Country event barn & retreat (Custom)', address: 'Texas (statewide factor)', exitCap: 0.085,
    project: project({ mode: 'custom', location: { region: 'TX' }, land: { mode: 'amount', value: 1400000, acres: 18 },
      components: [comp('k', 'custom', 1, { name: 'Event barn & retreat', blocks: [
        { id: 'b1', itemId: 'building-steel-preengineered', qty: 9000 },
        { id: 'b2', itemId: 'tenant-improvement-standard', qty: 9000 },
        { id: 'b3', itemId: 'site-development-light', qty: 6 },
        { id: 'b4', itemId: 'restroom-building', qty: 900 },
        { id: 'b5', itemId: 'pavilion-shade', qty: 3500 },
        { id: 'b6', itemId: 'parking-surface', qty: 180 },
        { id: 'b7', itemId: 'septic-system', qty: 2 },
        { id: 'b8', itemId: 'water-well', qty: 1 },
        { id: 'b9', itemId: 'commercial-kitchen', qty: 1200 },
        { id: 'b10', itemId: 'monument-sign', qty: 1 },
        { id: 'b11', itemId: '', name: 'Owner-supplied lighting package', unitCost: 85000, qty: 1, unit: 'ls' }],
        revenue: { mode: 'annual', rate: 1250000, vacancy: 0.10, expenseRatio: 0.55 } })] }) },

  { id: '16-solar-farm', name: 'Prairie Sun — 50 MWdc solar farm', address: 'Texas (statewide factor)', exitCap: 0.07,
    project: project({ location: { region: 'TX' }, land: { mode: 'perAcre', value: 9000 },
      components: [comp('c1', 'solar-farm', 50, { name: 'Solar array',
        revenue: { mode: 'annual', rate: 4600000, vacancy: 0.02, expenseRatio: 0.18 } })] }) }
];
