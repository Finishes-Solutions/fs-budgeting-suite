#!/usr/bin/env python3
"""Render BUILD_GUIDE.template.md -> BUILD_GUIDE.filled.md using guide.vars.

Zero dependencies. Unset variables stay as visible {{PLACEHOLDER}} markers and are
listed at the end so you know exactly what's still missing. Derived values:
  SQL_CONN_STRING  from SQL_SERVER, SQL_DB, APP_DB_USER, APP_DB_PASSWORD
  GITHUB_REPO      from GITHUB_ORG, GITHUB_REPO_NAME
Re-run any time; output is overwritten. NEVER commit guide.vars or the filled output.
"""
import re, sys, pathlib

here = pathlib.Path(__file__).parent
tpl_path = here / 'BUILD_GUIDE.template.md'
vars_path = here / 'guide.vars'
out_path = here / 'BUILD_GUIDE.filled.md'

if not vars_path.exists():
    sys.exit("guide.vars not found — copy guide.vars.example to guide.vars and fill it in.")

vals = {}
for line in vars_path.read_text().splitlines():
    line = line.split('#', 1)[0].strip() if not line.strip().startswith('#') else ''
    if '=' in line:
        k, v = line.split('=', 1)
        vals[k.strip()] = v.strip()

# ---- derived values ----
if not vals.get('GITHUB_REPO') and vals.get('GITHUB_ORG') and vals.get('GITHUB_REPO_NAME'):
    vals['GITHUB_REPO'] = f"github.com/{vals['GITHUB_ORG']}/{vals['GITHUB_REPO_NAME']}"
if not vals.get('SQL_CONN_STRING'):
    need = ['SQL_SERVER', 'SQL_DB', 'APP_DB_USER', 'APP_DB_PASSWORD']
    if all(vals.get(k) for k in need):
        vals['SQL_CONN_STRING'] = (
            f"Server=tcp:{vals['SQL_SERVER']}.database.windows.net,1433;"
            f"Database={vals['SQL_DB']};User Id={vals['APP_DB_USER']};"
            f"Password={vals['APP_DB_PASSWORD']};Encrypt=true;"
            "TrustServerCertificate=false;Connection Timeout=60")

text = tpl_path.read_text()
placeholders = sorted(set(re.findall(r'\{\{(\w+)\}\}', text)) - {'VARIABLE'})
missing = []
for k in placeholders:
    v = vals.get(k, '')
    if v:
        text = text.replace('{{' + k + '}}', v)
    else:
        missing.append(k)

out_path.write_text(text)
print(f"Rendered {out_path.name} — {len(placeholders) - len(missing)}/{len(placeholders)} variables filled.")
if missing:
    print("Still placeholders (fill in guide.vars and re-run):")
    for k in missing:
        print("  {{" + k + "}}")
if any(vals.get(k) for k in ('CLIENT_SECRET', 'SQL_ADMIN_PASSWORD', 'APP_DB_PASSWORD')):
    print("\n⚠ The filled guide now contains secrets. It is gitignored — keep it that way.")
