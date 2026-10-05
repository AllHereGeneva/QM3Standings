import json, random, unicodedata
random.seed(42)
gv = json.load(open('gazetteer.json'))
cn = gv['cn']
def norm(s):
    return unicodedata.normalize('NFKD', s).encode('ascii','ignore').decode('ascii').lower().strip()
manual = {  # exonym misses -> real coords
 ("Geneva","Switzerland"):[46.2044,6.1432],
 ("Lausanne","Switzerland"):[46.5197,6.6323],
 ("Bali","Indonesia"):[-8.4095,115.1889],
}
cities = [
 ("Geneva","Switzerland"),("Zurich","Switzerland"),("Lausanne","Switzerland"),
 ("Paris","France"),("Lyon","France"),("San Francisco","United States"),
 ("New York City","United States"),("Los Angeles","United States"),("Boston","United States"),
 ("Austin","United States"),("Seattle","United States"),("London","United Kingdom"),
 ("Berlin","Germany"),("Munich","Germany"),("Amsterdam","Netherlands"),
 ("Barcelona","Spain"),("Madrid","Spain"),("Lisbon","Portugal"),("Milan","Italy"),
 ("Rome","Italy"),("Vienna","Austria"),("Copenhagen","Denmark"),("Stockholm","Sweden"),
 ("Oslo","Norway"),("Helsinki","Finland"),("Dublin","Ireland"),("Brussels","Belgium"),
 ("Tokyo","Japan"),("Osaka","Japan"),("Kyoto","Japan"),("Seoul","South Korea"),
 ("Singapore","Singapore"),("Hong Kong","Hong Kong"),("Shanghai","China"),("Beijing","China"),
 ("Bangkok","Thailand"),("Bali","Indonesia"),("Jakarta","Indonesia"),("Mumbai","India"),
 ("Bengaluru","India"),("New Delhi","India"),("Chennai","India"),("Kathmandu","Nepal"),
 ("Dubai","United Arab Emirates"),("Tel Aviv","Israel"),("Istanbul","Turkey"),
 ("Cape Town","South Africa"),("Nairobi","Kenya"),("Cairo","Egypt"),
 ("Sydney","Australia"),("Melbourne","Australia"),("Auckland","New Zealand"),
 ("Toronto","Canada"),("Vancouver","Canada"),("Montreal","Canada"),("Mexico City","Mexico"),
 ("Sao Paulo","Brazil"),("Rio de Janeiro","Brazil"),("Buenos Aires","Argentina"),
 ("Santiago","Chile"),("Bogota","Colombia"),("Lima","Peru"),
]
# add several extra meditators in a few hub cities to demo dispersion + megapins
extra_hubs = [("Geneva","Switzerland",6),("San Francisco","United States",5),("Tokyo","Japan",4),("London","United Kingdom",4),("Paris","France",3)]
rows=[]
base=985
miss=[]
def coord_for(city,country):
    if (city,country) in manual: return manual[(city,country)]
    k=norm(city)+'|'+norm(country)
    if k in cn: return cn[k]
    miss.append(f"{city}, {country}")
    return None
idx=0
def cmi_at(i):
    return min(424, max(196, int(420 - i*3.6 + random.randint(-12, 12))))
def rand_date():
    day=random.randint(1,70)
    return f"2026-{5 + day//31:02d}-{1 + day%27:02d}"
for i,(city,country) in enumerate(cities):
    c=coord_for(city,country)
    e={"city":city,"country":country,"cmi":cmi_at(i),"date":rand_date()}
    if c: e["lat"],e["lon"]=c[0],c[1]
    rows.append(e)
for city,country,n in extra_hubs:
    c=coord_for(city,country)
    for j in range(n):
        e={"city":city,"country":country,"cmi":cmi_at(random.randint(3,45)),"date":rand_date()}
        if c: e["lat"],e["lon"]=c[0],c[1]
        rows.append(e)
rows.sort(key=lambda e:-e["cmi"])
out={"meta":{"title":"World CMI Leaderboard","subtitle":"Concentration & Mindfulness Index — meditators worldwide","unit":"CMI","scaleMax":1000,"updated":"2026-07-18"},"entries":rows}
json.dump(out, open('cmi-sample.json','w'), indent=2, ensure_ascii=False)
print("entries:", len(rows), "| misses:", miss)
