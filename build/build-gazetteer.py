import json, unicodedata, os

def norm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii','ignore').decode('ascii')
    return s.lower().strip()

# country code -> country name
cc2name = {}
with open('countryInfo.txt', encoding='utf-8') as f:
    for line in f:
        if line.startswith('#'): continue
        p = line.rstrip('\n').split('\t')
        if len(p) > 4 and p[0]:
            cc2name[p[0]] = p[4]

rows = []
with open('cities15000.txt', encoding='utf-8') as f:
    for line in f:
        p = line.split('\t')
        try:
            name = p[1]; ascii_name = p[2]; lat = float(p[4]); lon = float(p[5])
            cc = p[8]; pop = int(p[14]) if p[14] else 0
        except Exception:
            continue
        rows.append((pop, ascii_name, name, cc, lat, lon))

rows.sort(reverse=True)
TOP = 3000
rows = rows[:TOP]

by_city = {}          # normcity -> [lat,lon] (most populous, already sorted desc)
by_city_cc = {}       # normcity|cc -> [lat,lon]
by_city_country = {}  # normcity|normcountryname -> [lat,lon]
for pop, ascii_name, name, cc, lat, lon in rows:
    nc = norm(ascii_name)
    coord = [round(lat,4), round(lon,4)]
    if nc not in by_city:
        by_city[nc] = coord
    key_cc = nc + '|' + cc.lower()
    if key_cc not in by_city_cc:
        by_city_cc[key_cc] = coord
    cn = cc2name.get(cc)
    if cn:
        kcn = nc + '|' + norm(cn)
        if kcn not in by_city_country:
            by_city_country[kcn] = coord
    # also index the local (non-ascii) name normalized
    nloc = norm(name)
    if nloc != nc and nloc not in by_city:
        by_city[nloc] = coord

gaz = {"c": by_city, "cc": by_city_cc, "cn": by_city_country}
with open('gazetteer.json','w', encoding='utf-8') as f:
    json.dump(gaz, f, separators=(',',':'), ensure_ascii=True)
print("cities indexed:", len(by_city), "| cc keys:", len(by_city_cc), "| cn keys:", len(by_city_country))
print("bytes:", os.path.getsize('gazetteer.json'))
