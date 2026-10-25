# Sample output

Sixteen sample projects run through the v2 engine → budget document → pro forma → export by
`node tools/run-samples.js` (research data `2026.0c737c8255`). Each folder holds:

- `estimate.xlsx` / `estimate.pdf` — the estimate export (summary, components, phases, detail, draw schedules, sources & assumptions), built with the same fs-render pipeline as the app;
- `proforma.xlsx` — the whole-project investment analysis export from the unchanged pro forma engine;
- `project.json` — the engine inputs exactly as the Inputs page saves them;
- `result.json` — totals, per-component and per-phase results, range checks, warnings, and every pro forma scope that was run.

**Costs** come from the research bundle. **Revenue, land prices and exit caps are illustrative inputs** chosen only so each
sample can run through the pro forma; they are not research and should not be read as market rents or values.
Every budget ties to the classic budget arithmetic (`parts(doc).project`) to the cent — the runner refuses to write one that does not.

## Estimates

| Sample | Project | Location | Total project cost | Cost per primary unit | $/SF | Hard / soft / land | Range check |
|---|---|---|---:|---:|---:|---|---|
| [01-garden-multifamily](01-garden-multifamily/) | Cedar Hollow — garden multifamily | Katy, TX | $66,218,599 | $275,911 / unit | $262.77 | 69.4% / 23.2% / 7.4% | within |
| [02-podium-mixed-use-2-phase](02-podium-mixed-use-2-phase/) | Station Square — podium mixed-use, 2 phases | Austin, TX | $141,142,304 | mixed — see components | $446.65 | 70.0% / 23.1% / 6.9% | within, within |
| [03-select-service-hotel](03-select-service-hotel/) | Harbor Point — select-service hotel | Nashville, TN | $30,605,903 | $246,822 / key | $398.10 | 70.0% / 19.2% / 10.8% | within |
| [04-warehouse](04-warehouse/) | I-20 Logistics Center — bulk warehouse | Dallas–Fort Worth, TX | $47,072,339 | $147 / SF | $147.10 | 66.5% / 19.9% / 13.6% | within |
| [05-medical-office](05-medical-office/) | Desert Ridge MOB | Phoenix, AZ | $33,836,122 | $752 / SF | $751.91 | 71.1% / 21.0% / 8.0% | within |
| [06-retail-pad-qsr](06-retail-pad-qsr/) | Outparcel QSR with drive-thru | Atlanta, GA | $4,046,356 | $1,445 / SF | $1,445.13 | 57.6% / 12.5% / 29.9% | within |
| [07-self-storage](07-self-storage/) | Bayside Climate Storage | Tampa, FL | $17,701,929 | $201 / NRSF | $151.25 | 63.5% / 22.5% / 14.0% | within |
| [08-office-ti](08-office-ti/) | Fulton Market office TI | Chicago, IL | $8,621,399 | $392 / SF | $391.88 | 84.5% / 15.5% / 0.0% | within |
| [09-tiny-home-community](09-tiny-home-community/) | Cedar Pines tiny home community | Austin, TX | $3,314,793 | $82,870 / pad | — | 59.5% / 29.8% / 10.7% | within |
| [10-food-truck-park](10-food-truck-park/) | Pearl Yard food truck park | San Antonio, TX | $2,289,739 | $190,812 / pad | — | 49.1% / 11.6% / 39.2% | within |
| [11-rv-resort](11-rv-resort/) | Gulf Breeze RV Resort | Florida (statewide factor) | $9,487,485 | $63,250 / site | — | 72.4% / 19.1% / 8.4% | within |
| [12-marina](12-marina/) | Ashley River Marina | Charleston, SC | $21,008,592 | $105,043 / slip | — | 64.1% / 18.7% / 17.2% | within |
| [13-data-center](13-data-center/) | Ashburn Campus — 24 MW data center | Northern Virginia (Arlington factor) | $493,631,983 | $20,568 / kW | $1,714.00 | 76.9% / 16.9% / 6.2% | within |
| [14-master-planned-3-phase](14-master-planned-3-phase/) | Brazos Crossing — 3-phase master plan | Fort Worth, TX | $168,894,726 | mixed — see components | $285.20 | 72.5% / 21.0% / 6.6% | within, within, within, within |
| [15-custom-event-retreat](15-custom-event-retreat/) | Hill Country event barn & retreat (Custom) | Texas (statewide factor) | $9,381,122 | $9,381,122 / LS | — | 68.3% / 16.1% / 15.6% | within |
| [16-solar-farm](16-solar-farm/) | Prairie Sun — 50 MWdc solar farm | Texas (statewide factor) | $76,697,263 | $1,533,945 / MW | — | 84.5% / 12.5% / 3.0% | within |

## Pro forma handoff (per project, component and phase)

Purchase price = the scope's total project cost; Year-1 income from the component revenue inputs; 65% LTV permanent loan at 6.5%,
5-year hold, organisation defaults otherwise. "Yield on cost" is Year-1 NOI ÷ total cost.

| Sample | Scope | Cost (purchase price) | Year-1 potential income | Year-1 NOI | Yield on cost | 5-yr equity IRR |
|---|---|---:|---:|---:|---:|---:|
| 01-garden-multifamily | whole project | $66,218,599 | $5,184,000 | $3,079,776 | 4.7% | -4.2% |
| 02-podium-mixed-use-2-phase | whole project | $141,142,304 | $9,404,000 | $5,898,924 | 4.2% | -9.6% |
| 02-podium-mixed-use-2-phase | component Residential over podium | $133,794,159 | $8,568,000 | $5,241,430 | 3.9% | -15.2% |
| 02-podium-mixed-use-2-phase | component Ground-floor retail | $7,348,145 | $836,000 | $653,752 | 8.9% | 34.9% |
| 02-podium-mixed-use-2-phase | phase Phase 1 — podium + residential | $134,962,678 | $8,568,000 | $5,241,430 | 3.9% | -16.0% |
| 02-podium-mixed-use-2-phase | phase Phase 2 — retail fit-out | $6,179,626 | $836,000 | $653,752 | 10.6% | 44.0% |
| 03-select-service-hotel | whole project | $30,605,903 | $7,936,000 | $2,211,581 | 7.2% | 6.2% |
| 04-warehouse | whole project | $47,072,339 | $2,320,000 | $2,027,680 | 4.3% | -10.1% |
| 05-medical-office | whole project | $33,836,122 | $1,620,000 | $1,416,204 | 4.2% | -27.3% |
| 06-retail-pad-qsr | whole project | $4,046,356 | $210,000 | $203,700 | 5.0% | 1.3% |
| 07-self-storage | whole project | $17,701,929 | $1,716,000 | $1,040,052 | 5.9% | 7.0% |
| 08-office-ti | whole project | $8,621,399 | $0 | $0 | 0.0% | — |
| 09-tiny-home-community | whole project | $3,314,793 | $456,000 | $272,688 | 8.2% | 22.1% |
| 10-food-truck-park | whole project | $2,289,739 | $259,200 | $260,304 | 11.4% | 35.7% |
| 11-rv-resort | whole project | $9,487,485 | $2,175,000 | $936,375 | 9.9% | 29.9% |
| 12-marina | whole project | $21,008,592 | $2,300,000 | $1,202,500 | 5.7% | -4.0% |
| 13-data-center | whole project | $493,631,983 | $50,400,000 | $33,516,000 | 6.8% | 17.2% |
| 14-master-planned-3-phase | whole project | $168,894,726 | $16,124,000 | $7,727,876 | 4.6% | -8.0% |
| 14-master-planned-3-phase | component Garden apartments | $86,527,377 | $6,300,000 | $3,745,200 | 4.3% | -12.7% |
| 14-master-planned-3-phase | component Rental townhomes | $32,026,007 | $2,544,000 | $1,570,920 | 4.9% | -2.8% |
| 14-master-planned-3-phase | component Grocery-anchored center | $22,197,210 | $1,560,000 | $1,233,180 | 5.6% | 5.5% |
| 14-master-planned-3-phase | component Select-service hotel | $28,144,132 | $5,720,000 | $1,446,360 | 5.1% | 0.4% |
| 14-master-planned-3-phase | phase Phase 1 — infrastructure + apartments | $91,266,624 | $6,300,000 | $3,745,200 | 4.1% | -17.7% |
| 14-master-planned-3-phase | phase Phase 2 — townhomes + retail | $50,126,050 | $4,104,000 | $2,807,885 | 5.6% | 6.0% |
| 14-master-planned-3-phase | phase Phase 3 — hotel | $27,502,052 | $5,720,000 | $1,446,360 | 5.3% | 2.0% |
| 15-custom-event-retreat | whole project | $9,381,122 | $1,250,000 | $506,250 | 5.4% | -18.4% |
| 16-solar-farm | whole project | $76,697,263 | $4,600,000 | $3,696,560 | 4.8% | -14.2% |
