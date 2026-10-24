# Helpers for the Phase 7 second research pass: append sourced evidence and
# revise a value with an auditable note. Every quote here was read in the
# session that wrote it (docs/RESEARCH.md, "Second pass").
import json
ACC = "2026-10-24"
def load(p): return json.load(open(p))
def save(p, d): json.dump(d, open(p, 'w'), indent=2); open(p, 'a').write('\n')
def ev(d, metric, unit, title, url, publisher, quote, value=None, low=None, high=None, year=2026, region="United States", key="US", conf="low", scope=""):
    ids = {e['id'] for e in d.get('evidence', [])}
    n = 1
    while ('p2e%d' % n) in ids: n += 1
    e = {"id": 'p2e%d' % n, "metric": metric, "value": value, "low": low, "high": high, "unit": unit, "region": region,
         "regionKey": key, "dataYear": year, "source": {"title": title, "url": url, "publisher": publisher, "accessed": ACC},
         "quote": quote, "scopeNotes": scope, "confidence": conf}
    d.setdefault('evidence', []).append(e)
    return e['id']
def note(r, text): r['method'] = (r.get('method', '') + ' | Second pass (' + ACC + '): ' + text).strip(' |')
