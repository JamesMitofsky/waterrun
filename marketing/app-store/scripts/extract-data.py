"""Pull the DC demo run (route trace + fountains + seeded statuses) out of the
site's demoRoute.ts so the store art draws the same real loop the site does."""
import json, re, pathlib

root = pathlib.Path(__file__).resolve().parents[3]
src = (root / "apps/site/src/lib/demoRoute.ts").read_text()

trace_block = src.split("const DC_ROUTE_TRACE")[1].split("];")[0]
trace = [[float(a), float(b)] for a, b in re.findall(r"\[(-?\d+\.\d+),\s*(-?\d+\.\d+)\]", trace_block)]

fountain_block = src.split("export const DC_FOUNTAINS")[1].split("\n];")[0]
fountains = []
for m in re.finditer(r"id:\s*(\d+),\s*lat:\s*(-?[\d.]+),\s*lon:\s*(-?[\d.]+),[^}]*?name:\s*\"([^\"]+)\"", fountain_block, re.S):
    fountains.append({"id": int(m[1]), "lat": float(m[2]), "lon": float(m[3]), "name": m[4]})

out = {"trace": trace, "fountains": fountains}
dest = pathlib.Path(__file__).resolve().parents[1] / "src/dc-run.json"
dest.write_text(json.dumps(out))
print(len(trace), "trace points;", len(fountains), "fountains ->", dest)
