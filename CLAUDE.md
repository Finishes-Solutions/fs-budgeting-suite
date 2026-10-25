Read `AGENTS.md` — it is the agent context file for this repository.

## Hard rules (budgeting-v2 upgrade — these override convenience, always)

- Work on the branch `upgrade/budgeting-v2`, created from `staging`. Commit and push
  to it often. Only when everything in Phase 8 passes, merge it into `staging` with a
  normal merge (no force-push, no rewriting history) and push `staging`.
- Never push to `main`. Never force-push.
- Never commit secrets. Do not deploy anything. Do not run migrations against any
  live or shared database. Database/schema changes must be additive migration files
  that the owner applies themselves.
- Do not use connected tools (Supabase, Vercel, etc.) to change cloud resources.
- The app itself must NOT do live web scraping or call paid data APIs while it runs.
  Research happens during development and goes into versioned data files
  (`data/research/`) that ship with the app (compiled to `app/research-data.js`).
- Keep `docs/PROGRESS.md` up to date with what's done, what's next, what's blocked,
  research coverage, and "Things I need to do." A new session must be able to pick up
  from it with no other context. Record decisions in `docs/DECISIONS.md`.
- The pro forma (investment) engine's math and behaviour stay exactly as they are:
  `test/proforma-golden.test.js` must pass unchanged. Only how it receives inputs
  may change.
- Never invent a research source, URL, number or quote. Unsourced values are
  labelled "derived estimate — verify" with the method that produced them.
