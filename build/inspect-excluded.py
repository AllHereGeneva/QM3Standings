#!/usr/bin/env python3
# List the city-level files that have NO 'meditation'-named period, with their period sets.
import csv, os
from collections import Counter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
CITIES = {'Bengaluru','Bylakuppe','Hyderabad','Kamakura','Tokyo','Basel','Geneva','Oxford','LA','San Francisco'}
WML = ('WML','WMTL','WMLT')
sigs = Counter()
by_city = Counter()
for dp, _, fns in os.walk(DATA):
    for fn in fns:
        if not fn.lower().endswith('.csv'): continue
        rel = os.path.relpath(os.path.join(dp, fn), DATA).split(os.sep)
        if len(rel) != 3 or rel[1] not in CITIES: continue
        if any(fn.startswith(p) for p in WML): continue
        try:
            with open(os.path.join(dp, fn), encoding='utf-8-sig') as f:
                rows = list(csv.reader(f))
        except Exception: continue
        periods = [r[0] for r in rows[1:] if r]
        if any('meditation' in p.lower() for p in periods): continue
        by_city[rel[1]] += 1
        sigs[' | '.join(periods)] += 1
print('no-meditation files by city:', dict(by_city))
print('\ndistinct period signatures (count x signature):')
for sig, n in sigs.most_common():
    print('  %2d x  %s' % (n, sig[:120]))
