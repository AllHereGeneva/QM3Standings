# Build the vector world map (continent polygons) for the leaderboard.
# Source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson
# Usage: download that file as land110.json next to this script, then: python3 build-world-land.py

import json, os
gj = json.load(open('land110.json'))
feats = []
def round_ring(ring, nd=2):
    out = []; last = None
    for x, y in ring:
        p = [round(x, nd), round(y, nd)]
        if p != last:
            out.append(p); last = p
    return out
for feat in gj['features']:
    g = feat['geometry']
    if g['type'] == 'Polygon':
        polys = [g['coordinates']]
    elif g['type'] == 'MultiPolygon':
        polys = g['coordinates']
    else:
        continue
    for poly in polys:
        rings = [round_ring(r) for r in poly]
        rings = [r for r in rings if len(r) >= 4]
        if rings:
            feats.append(rings)
json.dump(feats, open('world-land.json','w'), separators=(',',':'))
print("polygons:", len(feats), "| bytes:", os.path.getsize('world-land.json'))
