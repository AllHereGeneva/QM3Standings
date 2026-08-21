/* =========================================================
   All Here — World CMI Leaderboard
   Vanilla JS, no dependencies. Renders a stylised dotted world
   map (canvas) with pan/zoom + clustered DOM pins, and a Top-N
   ranked list. Geocodes city+country via a bundled gazetteer,
   or uses explicit lat/lon when present in the data.

   Usage:
     AHLeaderboard.init(document.querySelector('.ahl'), {
       dataUrl: 'assets/data/cmi-sample.json',
       dotsUrl: 'assets/data/world-dots.json',
       gazetteerUrl: 'assets/data/gazetteer.json'
     });
   ========================================================= */
(function () {
  'use strict';

  var DEFAULTS = {
    dataUrl: 'assets/data/cmi-sample.json',
    landUrl: 'assets/data/world-land.json',
    gazetteerUrl: 'assets/data/gazetteer.json',
    listTop: 20,       // how many rows in the ranked list
    mapTop: 50,        // how many top entries to plot on the map
    scaleMax: 1000,    // CMI scale (overridden by data.meta.scaleMax)
    clusterPx: 30      // screen distance below which pins merge
  };

  // Equirectangular map window (cropped to skip empty poles).
  var MAP = { lonMin: -180, lonMax: 180, latMin: -58, latMax: 82 };
  var WORLD_ASPECT = (MAP.lonMax - MAP.lonMin) / (MAP.latMax - MAP.latMin);
  var MAX_ZOOM = 30;   // ~3/4 of the former cap (40)

  // ---- helpers ----
  function norm(s) {
    return (s || '')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function AHLeaderboard(root, opts) {
    this.root = root;
    this.opt = Object.assign({}, DEFAULTS, opts || {});
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dirty = true;
    this.highlightId = -1;
    this.pointers = new Map();
    this.pinchDist = 0;
    this.pinSel = null;   // ids currently spotlighted in the standings (from a pin click)
    this._lastTouch = false;
    this._noHover = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  }

  AHLeaderboard.prototype.init = function () {
    var self = this;
    this.buildShell();
    this.land = [];   // map draws in when it arrives; the page renders without it

    // ESSENTIAL (small): scores + geocoder — render the standings + pins ASAP.
    Promise.all([
      this.fetchStandings(),
      fetch(this.opt.gazetteerUrl).then(function (r) { return r.json(); }).catch(function () { return { c: {}, cc: {}, cn: {} }; })
    ]).then(function (res) {
      self.data = res[0];
      self.gaz = res[1];
      self.prepare();
      self.render();
    }).catch(function (err) {
      self.showError(err);
    });

    // HEAVY (map borders, ~1.3MB): load in the BACKGROUND and draw the continents
    // when ready. If it stalls or fails (e.g. slow mobile), the pins + standings
    // still work — the map just stays a plain backdrop.
    fetch(this.opt.landUrl).then(function (r) { return r.json(); }).then(function (land) {
      self.land = land;
      self.dirty = true;
      self.render();
    }).catch(function () { /* no map is fine */ });
  };

  // Load the standings document. Primary source = the read endpoint on the EEG /
  // neuro API (split-ready via opt.eegApiBase). Falls back to the bundled local
  // file if the endpoint is unset, unreachable, CORS-blocked, or errors — so the
  // page never goes blank. Always no-store (single current document, updated in place).
  AHLeaderboard.prototype.fetchStandings = function () {
    var self = this;
    var local = function () {
      return fetch(self.opt.dataUrl, { cache: 'no-store' }).then(function (r) { return r.json(); });
    };
    var base = this.opt.eegApiBase;
    if (!base) return local();
    var url = String(base).replace(/\/+$/, '') + '/eeg/standings/qm3';
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 3000) : null;
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (timer) clearTimeout(timer); if (!r.ok) throw new Error('standings ' + r.status); return r.json(); })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        console.warn('[AHLeaderboard] standings endpoint unavailable — using local file.', err && err.message);
        return local();
      });
  };

  // ---- geocoding ----
  AHLeaderboard.prototype.geocode = function (e) {
    if (typeof e.lat === 'number' && typeof e.lon === 'number') return [e.lat, e.lon];
    var g = this.gaz, nc = norm(e.city);
    if (!nc) return null;
    var byCn = g.cn[nc + '|' + norm(e.country)];
    if (byCn) return byCn;
    if (e.countryCode) {
      var byCc = g.cc[nc + '|' + String(e.countryCode).toLowerCase()];
      if (byCc) return byCc;
    }
    var byC = g.c[nc]; // last resort: most-populous city of that name
    return byC || null;
  };

  AHLeaderboard.prototype.prepare = function () {
    var meta = (this.data && this.data.meta) || {};
    this.scaleMax = meta.scaleMax || this.opt.scaleMax;
    this.unit = meta.unit || 'CMI';

    // SCORED entries (a real CMI) are ranked and listed; entries flagged as `dot`
    // (no score) are just non-interactive location markers on the map.
    var raw = (this.data.entries || []).slice();
    var scored = raw.filter(function (e) { return typeof e.cmi === 'number' && !e.dot; })
      .sort(function (a, b) { return b.cmi - a.cmi; });
    var dots = raw.filter(function (e) { return e.dot || typeof e.cmi !== 'number'; });
    scored.forEach(function (e, i) { e.rank = i + 1; e._dot = false; });
    dots.forEach(function (e) { e.rank = 0; e._dot = true; });
    var entries = scored.concat(dots);
    this.scoredCount = scored.length;

    var missing = [];
    entries.forEach(function (e, i) {
      e.id = i;
      var c = this.geocode(e);
      if (c) { e._lat = c[0]; e._lon = c[1]; }
      else { missing.push((e.city || e.country)); }
    }, this);
    this.entries = entries;
    if (missing.length) {
      console.warn('[AHLeaderboard] Could not locate ' + missing.length +
        ' place(s) on the map (add lat/lon to the data): ' + missing.join(' · '));
    }

    // entries plotted on the map: the top N with coordinates, PLUS every
    // featured (VIP) participant — so featured profiles stay on the map and
    // their cards remain reachable even when their score is outside the top N.
    // EVERY registered participant with coordinates goes on the map (not just a
    // top slice) — so the map reads as "a lot of people". VIPs are already in here.
    var withCoords = entries.filter(function (e) { return e._lat != null; });
    this.mapPins = withCoords.slice();

    // Same-city dispersion. Non-VIP duplicates get a GEOGRAPHIC offset (a small
    // lon/lat rosette) — so they merge into one count-pin when zoomed out, then
    // fan open into a visible crowd as you zoom in (the offset scales with the
    // map, staying glued to the ground — no swimming). VIP duplicates instead get
    // a CONSTANT screen-pixel offset so their profile card is always reachable.
    var groups = {};
    this.mapPins.forEach(function (e) {
      var k = e._lat.toFixed(2) + ',' + e._lon.toFixed(2);
      (groups[k] = groups[k] || []).push(e);
    });
    // Same-city pins get a GEOGRAPHIC rosette (_rx/_ry, scaled canvas-relatively in
    // renderPins) — glued to the ground, so NO screen-space drift: they sit tight on
    // the city at low zoom and only fan apart as you zoom in. (A pixel offset here
    // used to fling the top pin far offshore at low zoom and only settle at full zoom.)
    var GA = 2.399963;   // golden angle -> even sunflower packing
    Object.keys(groups).forEach(function (k) {
      var arr = groups[k];
      arr.forEach(function (e) { e._ox = e._oy = e._rx = e._ry = 0; });
      if (arr.length === 1) return;
      arr.forEach(function (e, i) {
        var rr = Math.sqrt(i);   // first pin stays centred on the city; rest fan out
        e._rx = Math.cos(i * GA) * rr;
        e._ry = Math.sin(i * GA) * rr;
      });
    });

    // distinct participant labels present in the data (for the filter)
    var seen = {}, labels = [];
    entries.forEach(function (e) {
      if (Array.isArray(e.labels)) e.labels.forEach(function (l) {
        if (l && l !== 'VIP' && !seen[l]) { seen[l] = 1; labels.push(l); }   // 'VIP' is a marker, not a filter
      });
    });
    this.labels = labels;
    this.activeLabels = {};
    this.pinSel = null;

    this.populateHeader(meta);
    this.buildList();
    this.buildFilter();
    if (!this._bound) {                 // one-time event wiring (survives dataset swaps)
      this.bindMap();
      this.bindPanel();
      this.bindCard();
      this._bound = true;
    }
    this.resize();
  };

  // swap the active dataset (e.g. Coverage <-> Map Index) without re-binding events
  AHLeaderboard.prototype.loadDataset = function (url) {
    var self = this;
    fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      self.data = d;
      self.opt.dataUrl = url;
      self.prepare();          // recompute entries/pins/list; view (zoom/pan) is preserved
      self.dirty = true;
      self.render();
    }).catch(function (err) { self.showError(err); });
  };

  // ---- DOM shell ----
  AHLeaderboard.prototype.buildShell = function () {
    var ds = this.opt.datasets;
    var curUrl = String(this.opt.dataUrl || '').split('?')[0];   // active dataset = the one loaded
    var dsHtml = (ds && ds.length >= 2)
      ? '<div class="ahl__dataset" data-ahl="dataset">' + ds.map(function (d, i) {
          var on = d.url === curUrl || (i === 0 && ds.every(function (x) { return x.url !== curUrl; }));
          return '<button type="button" class="ahl__ds-btn' + (on ? ' is-on' : '') +
            '" data-url="' + d.url + '">' + esc(d.label) + '</button>';
        }).join('') + '</div>'
      : '';
    this.root.innerHTML =
      '<div class="ahl__wrap">' +
        '<header class="ahl__head">' +
          '<nav class="ahl__nav">' +
            '<a class="ahl__nav-logo" href="https://www.wml.org" target="_blank" rel="noopener noreferrer">' +
              '<img src="assets/wml-logo.png?v=24" alt="World Meditation League" />' +
            '</a>' +
            '<div class="ahl__nav-links">' +
              '<a href="https://www.wml.org/tokyo-qm-challenge" target="_blank" rel="noopener noreferrer">Tokyo QM</a>' +
              '<a href="https://www.wml.org/geneva-qm-challenge" target="_blank" rel="noopener noreferrer">Geneva QM</a>' +
              '<a href="http://allhere.org/san-francisco-qm-sessions/" target="_blank" rel="noopener noreferrer">San Francisco QM</a>' +
              '<a href="https://www.wml.org/meditators-credentials" target="_blank" rel="noopener noreferrer">Credentials</a>' +
              '<a href="https://www.wml.org/updates" target="_blank" rel="noopener noreferrer">News</a>' +
              '<a href="https://www.wml.org/team" target="_blank" rel="noopener noreferrer">Team</a>' +
            '</div>' +
            '<a class="ahl__nav-cta" href="mailto:hello@wml.org">Join the League</a>' +
          '</nav>' +
          '<div class="ahl__hero">' +
            '<span class="ahl__eyebrow">QM3 Standings</span>' +
            '<h2 class="ahl__title" data-ahl="title">World Meditation Challenge</h2>' +
            '<div class="ahl__stats" data-ahl="stats"></div>' +
          '</div>' +
          '<button type="button" class="ahl__scrollcue" data-ahl="scrollcue" aria-label="Scroll to the map">' +
            '<span class="ahl__scrollcue-txt">Scroll</span>' +
            '<span class="ahl__scrollcue-chev" aria-hidden="true">⌄</span>' +
          '</button>' +
        '</header>' +
        '<div class="ahl__stage">' +
        '<div class="ahl__map" data-ahl="map">' +
          '<canvas data-ahl="canvas"></canvas>' +
          '<div class="ahl__pins" data-ahl="pins"></div>' +
          '<div class="ahl__tip" data-ahl="tip"></div>' +
          '<div class="ahl__card-backdrop" data-ahl="cardbg" hidden></div>' +
          '<div class="ahl__card" data-ahl="card" role="dialog" aria-modal="true" aria-label="Participant profile" hidden></div>' +
          dsHtml +
          '<div class="ahl__filter" data-ahl="filter">' +
            '<button type="button" class="ahl__filter-toggle" data-ahl="filtertoggle" aria-expanded="false">Filter</button>' +
            '<div class="ahl__filter-body">' +
              '<div class="ahl__filter-head">Filter by label</div>' +
              '<div class="ahl__filter-chips" data-ahl="filterchips"></div>' +
            '</div>' +
          '</div>' +
          '</div>' +
          '<aside class="ahl__listcard">' +
            '<button type="button" class="ahl__toggle" data-ahl="toggle" aria-label="Hide standings" aria-expanded="true">' +
              '<span class="ahl__toggle-label">QM3 Standings</span>' +
              '<span class="ahl__toggle-icon" aria-hidden="true">‹</span>' +
            '</button>' +
            '<h3 class="ahl__list-title" data-ahl="listtitle">QM3 Standings</h3>' +
            '<p class="ahl__list-sub" data-ahl="listsub"></p>' +
            '<div class="ahl__selbar" data-ahl="selbar" hidden></div>' +
            '<div class="ahl__rows" data-ahl="rows">' +
              '<div class="ahl__state"><div class="ahl__spinner"></div>Loading scores…</div>' +
            '</div>' +
            '<div class="ahl__footer" data-ahl="footer"></div>' +
          '</aside>' +
        '</div>' +
        '<footer class="ahl__foot">' +
          '<div class="ahl__foot-main">' +
            '<div class="ahl__foot-brand">' +
              '<span class="ahl__foot-name"><i class="ahl__foot-dot"></i>World Meditation League</span>' +
              '<span class="ahl__foot-tag">Inspire to Meditate — with Science &amp; Technology</span>' +
              '<span class="ahl__foot-addr">12 Clos Belmont, 1208 Geneva, Switzerland · ' +
                '<a href="mailto:hello@wml.org">hello@wml.org</a></span>' +
            '</div>' +
            '<nav class="ahl__foot-col">' +
              '<span class="ahl__foot-h">Quick Links</span>' +
              '<a href="https://www.wml.org/team" target="_blank" rel="noopener noreferrer">Team</a>' +
              '<a href="https://www.wml.org/wml-news" target="_blank" rel="noopener noreferrer">News</a>' +
              '<a href="https://www.wml.org/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>' +
            '</nav>' +
            '<nav class="ahl__foot-col">' +
              '<span class="ahl__foot-h">Events</span>' +
              '<a href="https://www.wml.org/tokyo-qm-challenge" target="_blank" rel="noopener noreferrer">Tokyo QM</a>' +
              '<a href="https://www.wml.org/geneva-qm-challenge" target="_blank" rel="noopener noreferrer">Geneva QM</a>' +
              '<a href="http://allhere.org/san-francisco-qm-sessions/" target="_blank" rel="noopener noreferrer">San Francisco QM</a>' +
            '</nav>' +
            '<nav class="ahl__foot-col">' +
              '<span class="ahl__foot-h">Connect</span>' +
              '<a href="https://www.linkedin.com/company/world-meditation-league/" target="_blank" rel="noopener noreferrer">LinkedIn</a>' +
              '<a href="https://www.instagram.com/allhere_organization/" target="_blank" rel="noopener noreferrer">Instagram</a>' +
              '<a href="https://www.youtube.com/@AllHereMeditation" target="_blank" rel="noopener noreferrer">YouTube</a>' +
            '</nav>' +
          '</div>' +
          '<div class="ahl__foot-bar">' +
            '<span class="ahl__foot-copy">© 2026 World Meditation League</span>' +
          '</div>' +
        '</footer>' +
      '</div>';

    this.el = {};
    var self = this;
    ['title', 'subtitle', 'stats', 'map', 'canvas', 'pins', 'tip',
      'zin', 'zout', 'zreset', 'listtitle', 'listsub', 'selbar', 'rows', 'footer', 'toggle', 'scrollcue', 'dataset',
      'card', 'cardbg', 'filter', 'filterchips', 'filtertoggle'
    ].forEach(function (k) {
      self.el[k] = self.root.querySelector('[data-ahl="' + k + '"]');
    });
    this.ctx = this.el.canvas.getContext('2d');
  };

  AHLeaderboard.prototype.showError = function (err) {
    console.error('[AHLeaderboard]', err);
    if (this.el && this.el.rows) {
      this.el.rows.innerHTML = '<div class="ahl__state">Could not load leaderboard data.</div>';
    }
  };

  AHLeaderboard.prototype.populateHeader = function (meta) {
    // The hero title is deliberately NOT taken from meta.title. It's the name of the
    // event, not a property of a scores feed — and the feed (the API's
    // /eeg/standings/qm3 meta) still says "QM3 Standings" there, which would put the
    // old name back on every load. That name now sits in the eyebrow above it.
    // meta.listTitle still drives the standings panel, which is feed-owned.
    this.el.listtitle.textContent = meta.listTitle || 'QM3 Standings';

    var countries = {};
    this.entries.forEach(function (e) { if (e.country) countries[e.country] = 1; });
    var count = meta.count != null ? String(meta.count) : fmtInt(this.entries.length);   // headline figure, e.g. "400+"
    var stats = [
      { n: count, l: 'Meditators' },
      { n: fmtInt(Object.keys(countries).length), l: 'Countries' }
    ];
    this.el.stats.innerHTML = stats.map(function (s) {
      return '<div class="ahl__stat"><span class="ahl__stat-num">' + esc(s.n) +
        '</span><span class="ahl__stat-label">' + s.l + '</span></div>';
    }).join('');

    this.el.listsub.textContent = 'Ranked by ' + this.unit +
      ' — Concentration & Mindfulness Index (0–' + fmtInt(this.scaleMax) + ')';

    var note = meta.note
      ? '<div class="ahl__note">' + esc(meta.note) +
          (meta.learnMoreUrl ? ' <a class="ahl__learn" href="' + esc(meta.learnMoreUrl) +
            '" target="_blank" rel="noopener noreferrer">Learn more &rarr;</a>' : '') + '</div>'
      : '';
    var footHtml = note +
      '<div class="ahl__foot-meta">' +
        (meta.updated ? '<span>Updated ' + fmtDate(meta.updated) + '</span>' : '') +
        '<span>' + esc(count) + ' meditators worldwide</span>' +
      '</div>';
    this.el.footer.innerHTML = footHtml;                        // in-panel standings footer
  };

  // ---- ranked list ----
  AHLeaderboard.prototype.buildList = function () {
    var self = this;
    var pinMode = !!(this.pinSel && this.pinSel.length);
    var fActive = !pinMode && this.filterActive();
    var top;
    if (pinMode) {
      // spotlight exactly the participants under the clicked pin, best rank first
      top = this.pinSel.map(function (id) { return self.entries[id]; })
        .filter(Boolean).sort(function (a, b) { return a.rank - b.rank; });
    } else if (fActive) {
      // surface the matching participants to the TOP (they keep their true rank),
      // then the rest of the ranking below, faded
      var matches = this.entries.filter(function (e) { return self.entryMatches(e); });
      var rest = this.entries.filter(function (e) { return !self.entryMatches(e); });
      top = matches.concat(rest).slice(0, Math.max(this.opt.listTop, matches.length));
    } else {
      top = this.entries.filter(function (e) { return !e._dot; }).slice(0, this.opt.listTop);
    }
    // selection bar (pin click) — a back button + context, reusing this panel
    if (this.el.selbar) {
      if (pinMode) {
        var cities = {};
        top.forEach(function (e) { cities[e.city] = 1; });
        var ck = Object.keys(cities);
        var place = ck.length === 1 ? top[0].city + ', ' + top[0].country : ck.length + ' locations';
        this.el.selbar.innerHTML =
          '<button type="button" class="ahl__selclear" data-ahl="selclear" aria-label="Show all">‹ Show all</button>' +
          '<span class="ahl__seltxt">' + esc(String(top.length)) + (top.length > 1 ? ' meditators' : ' meditator') +
          ' · ' + esc(place) + '</span>';
        this.el.selbar.hidden = false;
        var clr = this.el.selbar.querySelector('[data-ahl="selclear"]');
        if (clr) clr.onclick = function () { self.clearPinSel(); };
      } else {
        this.el.selbar.hidden = true;
        this.el.selbar.innerHTML = '';
      }
    }
    this.el.rows.innerHTML = top.map(function (e) {
      var rankCls = e.rank <= 3 ? ' rank-' + e.rank : '';
      var who = e.vip ? e.vip.name : (e.dbg || 'Participant ' + e.rank);   // e.dbg = TEMP debug filename
      var stateCls = fActive ? (self.entryMatches(e) ? ' is-match' : ' is-dim') : '';
      return '<div class="ahl__row' + rankCls + stateCls + '" data-id="' + e.id + '" role="button" tabindex="0">' +
        '<div class="ahl__rank">' + e.rank + '</div>' +
        '<div class="ahl__place">' +
          '<div class="ahl__city">' + esc(who) + '</div>' +
          '<div class="ahl__meta"><span>' + esc(e.city ? e.city + ', ' + e.country : e.country) + '</span></div>' +
        '</div>' +
        '<div class="ahl__score"><div class="ahl__cmi">' + fmtInt(e.cmi) + '</div></div>' +
      '</div>';
    }).join('');

    // hover / focus linking list -> map
    Array.prototype.forEach.call(this.el.rows.querySelectorAll('.ahl__row'), function (row) {
      var id = +row.getAttribute('data-id');
      row.addEventListener('mouseenter', function () {
        self.setHighlight(id);
        var e = self.entries[id];
        // hovering a bio-performer's row opens their profile card too (desktop)
        if (e && e.vip && !self._noHover && !self._lastTouch) self.openVipCard(e, self.pinNodeFor(id), true);
      });
      row.addEventListener('mouseleave', function () {
        self.setHighlight(-1);
        if (self._cardMode === 'hover') self.closeVipCard();
      });
      row.addEventListener('focus', function () { self.focusEntry(id); });
      row.addEventListener('click', function () { self.focusEntry(id); });
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); self.focusEntry(id); }
      });
    });
  };

  // pin click -> show its members in the standings panel, and frame them on the map
  AHLeaderboard.prototype.selectPins = function (ids, pin) {
    this.pinSel = ids.slice();
    var card = this.root.querySelector('.ahl__listcard');
    if (card) card.classList.remove('is-collapsed');   // make sure the panel is open
    this.buildList();
    if (this.el.rows) this.el.rows.scrollTop = 0;
    // NB: no scrollIntoView — on mobile the map + standings share one screen,
    // so the selection updates in place without leaving the map.
    // map response: fit a cluster, or pan to a single participant
    if (ids.length > 1 && pin) this.fitCluster(pin);
    else this.focusEntry(ids[0]);
  };
  AHLeaderboard.prototype.clearPinSel = function () {
    this.pinSel = null;
    this.buildList();
    this.setHighlight(-1);
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- projection & transform ----
  AHLeaderboard.prototype.unitOf = function (lon, lat) {
    return {
      u: (lon - MAP.lonMin) / (MAP.lonMax - MAP.lonMin),
      v: (MAP.latMax - lat) / (MAP.latMax - MAP.latMin)
    };
  };

  AHLeaderboard.prototype.resize = function () {
    var rect = this.el.map.getBoundingClientRect();
    if (!rect.width) return;
    this.cw = rect.width; this.ch = rect.height;
    // Always FILL the map's height. The world wraps horizontally (infinite pan),
    // so there is never a vertical letterbox: on a wide screen you see the whole
    // world; on a tall phone you see a full-height slice and pan sideways.
    this.worldH = this.ch;
    this.worldW = this.ch * WORLD_ASPECT;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.el.canvas.width = Math.round(this.cw * this.dpr);
    this.el.canvas.height = Math.round(this.ch * this.dpr);
    // frame clear of the floating panel on first load; afterwards preserve pan
    if (!this._framed) { this._framed = true; this.centerView(); }
    else { this.clampPan(); this.dirty = true; this.render(); }
  };

  // horizontal pan is free (world wraps infinitely); only the vertical axis clamps
  AHLeaderboard.prototype.clampPan = function () {
    var wh = this.worldH * this.zoom;
    this.pan.y = wh <= this.ch ? (this.ch - wh) / 2 : clamp(this.pan.y, this.ch - wh, 0);
  };

  // width (px) occluded by the standings panel on the right, or 0 when the
  // panel is collapsed / on mobile. Shared by framing, cluster-fit and header.
  AHLeaderboard.prototype.panelInset = function () {
    if (window.innerWidth <= 820) return 0;
    var panel = this.root.querySelector('.ahl__listcard');
    if (!panel || panel.classList.contains('is-collapsed')) return 0;
    var pr = panel.getBoundingClientRect(), mr = this.el.map.getBoundingClientRect();
    return pr.width + Math.max(0, mr.right - pr.right);
  };

  // center the default/reset view in the area left of the right-docked panel
  AHLeaderboard.prototype.centerView = function () {
    this.cancelAnim();
    var rightInset = this.panelInset();
    this.pan.x = (this.cw - rightInset - this.worldW * this.zoom) / 2;
    this.clampPan();
    this.dirty = true;
    this.render();
  };

  AHLeaderboard.prototype.setZoom = function (z, cx, cy) {
    this.cancelAnim();
    z = clamp(z, 1, MAX_ZOOM);
    if (cx == null) { cx = this.cw / 2; cy = this.ch / 2; }
    var wx = (cx - this.pan.x) / this.zoom;
    var wy = (cy - this.pan.y) / this.zoom;
    this.zoom = z;
    this.pan.x = cx - wx * z;
    this.pan.y = cy - wy * z;
    this.clampPan();
    this.dirty = true;
    this.render();
  };

  // ---- map interaction ----
  AHLeaderboard.prototype.bindMap = function () {
    var self = this, map = this.el.map;

    // overlay controls that must receive their own clicks/scroll, not the map
    var OVERLAY_SEL = '.ahl__mapctrl, .ahl__filter, .ahl__listcard, .ahl__toggle, ' +
      '.ahl__card, .ahl__card-backdrop, a, button';
    function onOverlay(ev) {
      return !!(ev.target && ev.target.closest && ev.target.closest(OVERLAY_SEL));
    }

    // stop the browser's native image/element drag (ghost image) when panning
    map.addEventListener('dragstart', function (ev) { ev.preventDefault(); });

    map.addEventListener('wheel', function (ev) {
      if (onOverlay(ev)) return;   // let the standings list / panels scroll normally
      ev.preventDefault();
      var r = map.getBoundingClientRect();
      self.setZoom(self.zoom * Math.exp(-ev.deltaY * 0.0016), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    map.addEventListener('pointerdown', function (ev) {
      // don't pan/capture on controls OR on a pin — otherwise pointer capture
      // swallows the pin's click and the cluster never auto-zooms
      if (onOverlay(ev) || (ev.target.closest && ev.target.closest('.ahl__pin'))) return;
      self.cancelAnim();
      // capture to pan — EXCEPT mobile touch at fit-zoom, where the browser needs the
      // vertical gesture to scroll/snap between screens. Once zoomed, the map captures.
      var touchScroll = ev.pointerType === 'touch' && window.innerWidth <= 820 && self.zoom <= 1.02;
      if (!touchScroll) map.setPointerCapture(ev.pointerId);
      self.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (self.pointers.size === 1) { map.classList.add('is-panning'); self._moved = false; self._vx = self._vy = 0; }
      if (self.pointers.size === 2) { self.pinchDist = self.twoDist(); }
    });
    map.addEventListener('pointermove', function (ev) {
      if (!self.pointers.has(ev.pointerId)) return;
      var prev = self.pointers.get(ev.pointerId);
      var dx = ev.clientX - prev.x, dy = ev.clientY - prev.y;
      self.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (self.pointers.size >= 2) {   // pinch-zoom (desktop + mobile), clipped by the map's overflow
        var d = self.twoDist(), mid = self.twoMid(), r = map.getBoundingClientRect();
        if (self.pinchDist > 0) self.setZoom(self.zoom * (d / self.pinchDist), mid.x - r.left, mid.y - r.top);
        self.pinchDist = d;
        return;
      }
      if (Math.abs(dx) + Math.abs(dy) > 2) self._moved = true;
      // mobile touch at fit-zoom: pan the globe HORIZONTALLY (it wraps); the vertical
      // gesture belongs to the page (scroll/snap). Once zoomed in, the map owns both axes.
      var fitTouch = ev.pointerType === 'touch' && window.innerWidth <= 820 && self.zoom <= 1.02;
      self.pan.x += dx;
      if (!fitTouch) self.pan.y += dy;
      // track a smoothed release velocity (px/frame) for inertia
      self._vx = dx * 0.65 + (self._vx || 0) * 0.35;
      self._vy = fitTouch ? 0 : (dy * 0.65 + (self._vy || 0) * 0.35);
      self._lastMoveT = Date.now();
      self.clampPan(); self.dirty = true; self.render();
    });
    function up(ev) {
      var endedPan = self.pointers.size === 1;   // fling glide for mouse and touch alike
      self.pointers.delete(ev.pointerId);
      if (self.pointers.size < 2) self.pinchDist = 0;
      if (self.pointers.size === 0) {
        map.classList.remove('is-panning');
        // fling: glide only if the drag was still moving at release
        if (endedPan && self._moved && (Date.now() - (self._lastMoveT || 0)) < 90) self.glide();
      }
    }
    map.addEventListener('pointerup', up);
    map.addEventListener('pointercancel', up);

    // pin interactions (delegated)
    function pinVip(pin) {
      if (+pin.dataset.count > 1) return null;               // clusters aren't a single VIP
      var e = self.entries[+(pin.dataset.ids || '').split(',')[0]];
      return (e && e.vip) ? e : null;
    }
    this.el.pins.addEventListener('mouseover', function (ev) {
      if (self._noHover || self._lastTouch) return;           // touch: click filters the panel instead
      var pin = ev.target.closest('.ahl__pin'); if (!pin) return;
      var vip = pinVip(pin);
      if (vip) { self.openVipCard(vip, pin, true); self.markRows([vip.id], true); self._hoverRows = [vip.id]; }
      else self.hoverPin(pin);                                // non-VIP -> small tooltip
    });
    this.el.pins.addEventListener('mouseout', function (ev) {
      if (self._noHover || self._lastTouch) return;
      var pin = ev.target.closest('.ahl__pin'); if (!pin) return;
      if (self._cardMode === 'hover') self.closeVipCard();    // close hover-opened card
      self.hideTip(); self.setHighlight(-1);
    });
    // click a pin -> spotlight its participant(s) in the standings panel (no floating popup)
    this.el.pins.addEventListener('click', function (ev) {
      var pin = ev.target.closest('.ahl__pin'); if (!pin) return;
      if (self._cardMode === 'hover') self.closeVipCard();
      self.hideTip();
      var ids = (pin.dataset.ids || '').split(',').map(Number)
        .filter(function (n) { return !isNaN(n) && self.entries[n] && !self.entries[n]._dot; });   // skip score-less dots
      if (ids.length) self.selectPins(ids, pin);
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () { self.resize(); }).observe(this.el.map);
    } else {
      window.addEventListener('resize', function () { self.resize(); });
    }

    // remember whether the last interaction was touch (drives whether any
    // floating tooltip/hover-card is allowed at all)
    this.root.addEventListener('pointerdown', function (ev) {
      self._lastTouch = ev.pointerType === 'touch';
    }, true);

    // mobile: scroll cue jumps to the map screen; fade it once the user scrolls
    var wrap = this.root.querySelector('.ahl__wrap');
    if (this.el.scrollcue) this.el.scrollcue.addEventListener('click', function () {
      var stage = self.root.querySelector('.ahl__stage');
      if (stage) stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    if (wrap) wrap.addEventListener('scroll', function () {
      wrap.classList.toggle('is-scrolled', wrap.scrollTop > 30);
    });

    // dataset toggle (e.g. Coverage <-> Map Index)
    if (this.el.dataset) this.el.dataset.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.ahl__ds-btn');
      if (!btn || btn.classList.contains('is-on')) return;
      Array.prototype.forEach.call(self.el.dataset.children, function (b) { b.classList.remove('is-on'); });
      btn.classList.add('is-on');
      self.loadDataset(btn.getAttribute('data-url'));
    });
  };

  // ---- retractable standings panel ----
  AHLeaderboard.prototype.bindPanel = function () {
    var self = this;
    var card = this.root.querySelector('.ahl__listcard');
    var btn = this.el.toggle;
    if (!card || !btn) return;
    function setState(collapsed) {
      card.classList.toggle('is-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', collapsed ? 'Show standings' : 'Hide standings');
    }
    btn.addEventListener('click', function () {
      self._panelUserToggled = true;
      setState(!card.classList.contains('is-collapsed'));
    });
    // standings are shown by default (desktop and mobile); the tab collapses them
    // to reveal the full-screen map underneath
  };

  // ---- label filter (replaces the old legend) ----
  AHLeaderboard.prototype.buildFilter = function () {
    var self = this;
    if (!this.el.filterchips) return;
    if (!this.labels.length) { this.el.filter.style.display = 'none'; return; }
    this.el.filterchips.innerHTML = this.labels.map(function (l) {
      return '<button type="button" class="ahl__chip" data-label="' + esc(l) +
        '" aria-pressed="false">' + esc(l) + '</button>';
    }).join('');

    // chip toggles a label (multiple active = OR)
    Array.prototype.forEach.call(this.el.filterchips.querySelectorAll('.ahl__chip'), function (chip) {
      chip.addEventListener('click', function () {
        var l = chip.getAttribute('data-label');
        var on = !self.activeLabels[l];
        if (on) self.activeLabels[l] = 1; else delete self.activeLabels[l];
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
        self.pinSel = null;   // a label filter supersedes a pin spotlight
        self.applyFilter();
      });
    });

    // mobile: the box collapses to a "Filter" chip that expands
    this.el.filtertoggle.addEventListener('click', function () {
      var open = self.el.filter.classList.toggle('is-open');
      self.el.filtertoggle.setAttribute('aria-expanded', String(open));
    });
  };

  AHLeaderboard.prototype.filterActive = function () {
    for (var k in this.activeLabels) if (this.activeLabels.hasOwnProperty(k)) return true;
    return false;
  };
  AHLeaderboard.prototype.entryMatches = function (e) {
    if (!e || !Array.isArray(e.labels)) return false;
    for (var i = 0; i < e.labels.length; i++) if (this.activeLabels[e.labels[i]]) return true;
    return false;
  };

  // re-highlight rows + pins for the current filter
  AHLeaderboard.prototype.applyFilter = function () {
    this.buildList();   // rebuild: matching participants float to the top, highlighted; rest faded
    this.dirty = true;
    this.render();      // re-render the map pins for the filter
  };

  // ---- VIP participant card ----
  AHLeaderboard.prototype.bindCard = function () {
    var self = this;
    this.el.cardbg.addEventListener('click', function () { self.closeVipCard(); });
    this.el.card.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-ahl="cardclose"]')) self.closeVipCard();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (self._cardOpen) self.closeVipCard();
      else if (self.pinSel) self.clearPinSel();
    });
  };

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    var a = parts[0] ? parts[0].charAt(0) : '';
    var b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (a + b).toUpperCase() || '·';
  }

  // find the currently-rendered pin node that contains this entry id (or null)
  AHLeaderboard.prototype.pinNodeFor = function (id) {
    var pool = this._pool || [], sid = String(id);
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].style.display === 'none') continue;
      if ((pool[i].dataset.ids || '').split(',').indexOf(sid) >= 0) return pool[i];
    }
    return null;
  };

  AHLeaderboard.prototype.openVipCard = function (e, pin, hover) {
    var v = e.vip; if (!v) return;
    var media = v.photo
      ? '<img class="ahl__card-photo" src="' + esc(v.photo) + '" alt="' + esc(v.name) + '" />'
      : '<div class="ahl__card-mono" aria-hidden="true">' + esc(initials(v.name)) + '</div>';
    var tag = v.tag ? '<span class="ahl__card-tag">' + esc(v.tag) + '</span>' : '';
    this.el.card.innerHTML =
      '<button type="button" class="ahl__card-close" data-ahl="cardclose" aria-label="Close">×</button>' +
      '<div class="ahl__card-head">' + media +
        '<div class="ahl__card-id">' +
          '<div class="ahl__card-name">' + esc(v.name) + '</div>' +
          '<div class="ahl__card-place">' + esc(e.city) + ', ' + esc(e.country) + '</div>' +
          tag +
        '</div>' +
      '</div>' +
      '<p class="ahl__card-bio">' + esc(v.bio || '') + '</p>' +
      '<div class="ahl__card-foot">Rank #' + e.rank + ' · ' + fmtInt(e.cmi) + ' ' + esc(this.unit) + '</div>';

    this._cardOpen = true;
    this._cardMode = hover ? 'hover' : 'click';
    this.el.cardbg.hidden = !!hover;   // hover mode is a rich tooltip — no click-away backdrop
    this.el.card.hidden = false;

    // position near the pin (desktop); CSS centers it as a modal on mobile
    if (window.innerWidth > 820 && pin) {
      var cx = +pin.dataset.sx, cy = +pin.dataset.sy;
      var cw = this.el.card.offsetWidth, chh = this.el.card.offsetHeight;
      var below = cy - chh - 18 < 0;
      var x = clamp(cx, cw / 2 + 8, this.cw - cw / 2 - 8);
      var y = clamp(below ? cy + 18 : cy - chh - 18, 8, Math.max(8, this.ch - chh - 8));
      this.el.card.style.left = x + 'px';
      this.el.card.style.top = y + 'px';
      this.el.card.style.transform = 'translateX(-50%)';
    } else {
      this.el.card.style.left = '';
      this.el.card.style.top = '';
      this.el.card.style.transform = '';
    }
  };

  AHLeaderboard.prototype.closeVipCard = function () {
    this._cardOpen = false;
    this._cardMode = null;
    this.el.card.hidden = true;
    this.el.cardbg.hidden = true;
  };

  AHLeaderboard.prototype.twoDist = function () {
    var p = Array.from(this.pointers.values());
    return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  };
  AHLeaderboard.prototype.twoMid = function () {
    var p = Array.from(this.pointers.values());
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
  };

  // ---- render loop ----
  AHLeaderboard.prototype.render = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () {
      self._raf = null;
      if (!self.dirty) return;
      self.dirty = false;
      // when zoomed in, the map captures touch (pan both axes); at fit-zoom it
      // releases the vertical gesture so the page can scroll/snap
      if (self.el.map) self.el.map.classList.toggle('is-zoomed', self.zoom > 1.02);
      self.drawLand();
      self.renderPins();
    });
  };

  AHLeaderboard.prototype.drawLand = function () {
    var ctx = this.ctx, dpr = this.dpr;
    if (!ctx || !this.land) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(74,124,214,0.16)';       // soft land fill (logo blue tint)
    ctx.strokeStyle = 'rgba(120,152,224,0.22)';    // faint borders / coastline
    ctx.lineWidth = 0.6;
    var lm = MAP.lonMin, lr = MAP.lonMax - MAP.lonMin;
    var tm = MAP.latMax, vr = MAP.latMax - MAP.latMin;
    var ww = this.worldW * this.zoom, wh = this.worldH * this.zoom;
    var px = this.pan.x, py = this.pan.y, cw = this.cw, ch = this.ch;
    // tile the world horizontally so the map wraps seamlessly with infinite pan
    var kStart = Math.floor((-px) / ww) - 1;
    var kEnd = Math.ceil((cw - px) / ww) + 1;
    for (var k = kStart; k <= kEnd; k++) {
      var ox = px + k * ww;
      for (var f = 0; f < this.land.length; f++) {
        var rings = this.land[f];
        // quick bbox cull in screen space
        var bb = this._bbox(rings[0]);
        var x0 = (bb[0] - lm) / lr * ww + ox, x1 = (bb[2] - lm) / lr * ww + ox;
        var y0 = (tm - bb[3]) / vr * wh + py, y1 = (tm - bb[1]) / vr * wh + py;
        if (x1 < 0 || x0 > cw || y1 < 0 || y0 > ch) continue;
        ctx.beginPath();
        for (var r = 0; r < rings.length; r++) {
          var ring = rings[r];
          for (var i = 0; i < ring.length; i++) {
            var x = (ring[i][0] - lm) / lr * ww + ox;
            var y = (tm - ring[i][1]) / vr * wh + py;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
        ctx.fill('evenodd');
        ctx.stroke();
      }
    }
  };

  AHLeaderboard.prototype._bbox = function (ring) {
    var minx = 180, miny = 90, maxx = -180, maxy = -90;
    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    return [minx, miny, maxx, maxy];
  };

  AHLeaderboard.prototype.renderPins = function () {
    if (!this.mapPins) return;
    var fActive = this.filterActive();
    // when a label filter is on: show ONLY the matching participants, and never
    // merge them — so you see exactly N unique pins, not a count-cluster
    var TH = fActive ? -1 : this.opt.clusterPx, m = 26;
    var ww = this.worldW * this.zoom, wh = this.worldH * this.zoom;
    var px = this.pan.x, py = this.pan.y;
    var kStart = Math.floor((-px) / ww) - 2;
    var kEnd = Math.ceil((this.cw - px) / ww) + 2;
    // project (best score first so clusters anchor on the best entry); render
    // each pin on whichever horizontal world copy is currently on screen.
    // Same-city dispersion is a CONSTANT pixel offset (never scaled by zoom) so
    // pins stay glued to their location and never swim while zooming.
    // canvas-relative dispersion: ~1.6px between neighbours per zoom level, so the
    // rosette merges into one count-pin at zoom 1 and fans wide open at max zoom,
    // identically on phone and desktop.
    var disp = 160 / this.cw;   // degrees per unit-rosette step (tight: stays on the city, no offshore drift)
    var pts = [];
    this.mapPins.forEach(function (e) {
      if (fActive && !this.entryMatches(e)) return;   // filter: only matching participants
      var uv = this.unitOf(e._lon + (e._rx || 0) * disp, e._lat + (e._ry || 0) * disp);
      var baseX = uv.u * ww;
      var screenY = uv.v * wh + py + (e._oy || 0);
      for (var k = kStart; k <= kEnd; k++) {
        var screenX = baseX + px + k * ww + (e._ox || 0);
        if (screenX >= -m && screenX <= this.cw + m) pts.push({ e: e, x: screenX, y: screenY });
      }
    }, this);

    // greedy screen-space clustering
    var oneDot = !!(this.data && this.data.meta && this.data.meta.oneDotEach);
    var clusters = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], placed = false;
      var solo = oneDot || p.e.rank <= 3;       // top-3 always solo; oneDotEach -> everyone solo (no counts)
      if (!solo) {
        for (var c = 0; c < clusters.length; c++) {
          var cl = clusters[c];
          if (cl.solo) continue;                // and nothing merges into a top-3's pin
          if (Math.hypot(p.x - cl.x, p.y - cl.y) <= TH) {
            cl.items.push(p.e); placed = true; break;
          }
        }
      }
      if (!placed) clusters.push({ x: p.x, y: p.y, items: [p.e], solo: solo });
    }

    // pool of pin nodes
    this._pool = this._pool || [];
    var pool = this._pool, layer = this.el.pins;
    while (pool.length < clusters.length) {
      var node = document.createElement('div');
      node.className = 'ahl__pin';
      node.innerHTML = '<span class="ahl__pin-dot"></span>';
      layer.appendChild(node);
      pool.push(node);
    }

    for (var k = 0; k < pool.length; k++) {
      var el = pool[k];
      if (k >= clusters.length) { el.style.display = 'none'; continue; }
      var clu = clusters[k];
      var onScreen = clu.x >= -m && clu.x <= this.cw + m && clu.y >= -m && clu.y <= this.ch + m;
      el.style.display = onScreen ? '' : 'none';
      if (!onScreen) continue;
      el.style.transform = 'translate(' + clu.x + 'px,' + clu.y + 'px)';
      el.dataset.sx = clu.x; el.dataset.sy = clu.y;
      el.dataset.count = clu.items.length;
      el.dataset.ids = clu.items.map(function (e) { return e.id; }).join(',');
      var best = clu.items[0];
      var dot = el.firstChild;
      el.classList.remove('is-rank-1', 'is-rank-2', 'is-rank-3');
      if (clu.items.length > 1) {
        el.classList.add('is-cluster'); el.classList.remove('is-top', 'is-vip', 'is-dot');
        dot.textContent = clu.items.length;
      } else {
        el.classList.remove('is-cluster');
        var isDot = !!best._dot;                       // score-less, non-interactive marker
        el.classList.toggle('is-dot', isDot);
        el.classList.toggle('is-top', !isDot && best.rank <= 3);
        if (!isDot && best.rank <= 3) el.classList.add('is-rank-' + best.rank);
        el.classList.toggle('is-vip', !!best.vip);   // distinct marker for VIPs
        dot.textContent = '';
      }
      // grey out anyone outside the top 20 (VIPs always stay highlighted)
      el.classList.toggle('is-sub', !best._dot && best.rank > 20 && !best.vip);
      // highlight state (from list hover)
      var active = this.highlightId >= 0 && clu.items.some(function (e) { return e.id === this.highlightId; }, this);
      el.classList.toggle('is-active', active);
      // label filter: pop matches, dim the rest
      if (this.filterActive()) {
        var match = clu.items.some(function (e) { return this.entryMatches(e); }, this);
        el.classList.toggle('is-match', match);
        el.classList.toggle('is-dim', !match);
      } else {
        el.classList.remove('is-match', 'is-dim');
      }
    }
    this._clusters = clusters;

    // keep tooltip glued to an active highlighted pin (desktop hover only —
    // never after a pin-click selection, and never on touch input)
    if (this.highlightId >= 0 && !this.pinSel && !this._lastTouch) {
      var hit = null;
      for (var q = 0; q < clusters.length; q++) {
        if (clusters[q].items.some(function (e) { return e.id === this.highlightId; }, this)) { hit = clusters[q]; break; }
      }
      if (hit && hit.x >= 0 && hit.x <= this.cw && hit.y >= 0 && hit.y <= this.ch) this.showTip(hit);
    }
  };

  // ---- tooltip + highlight ----
  AHLeaderboard.prototype.hoverPin = function (pin) {
    var ids = (pin.dataset.ids || '').split(',').map(Number);
    var clu = { x: +pin.dataset.sx, y: +pin.dataset.sy, items: ids.map(function (id) { return this.entries[id]; }, this) };
    this.showTip(clu);
    this.markRows(ids, true);
    this._hoverRows = ids;
  };

  AHLeaderboard.prototype.showTip = function (clu) {
    var tip = this.el.tip, best = clu.items[0];
    var html;
    if (best._dot) {
      // score-less marker: just the place name
      html = '<div class="ahl__tip-city">' + esc(best.city ? best.city + ', ' + best.country : best.country) + '</div>';
    } else if (clu.items.length > 1) {
      html = '<div class="ahl__tip-rank">' + clu.items.length + ' meditators</div>' +
        '<div class="ahl__tip-city">' + esc(best.city) + '</div>' +
        '<div class="ahl__tip-country">' + esc(best.country) + '</div>' +
        '<div class="ahl__tip-cmi">#' + best.rank + ' · ' + fmtInt(best.cmi) + ' <small>top ' + this.unit + '</small></div>' +
        '<div class="ahl__tip-more">Zoom in to expand this cluster</div>';
    } else {
      html = '<div class="ahl__tip-rank">Rank #' + best.rank + '</div>' +
        '<div class="ahl__tip-city">' + esc(best.vip ? best.vip.name : (best.dbg || 'Participant ' + best.rank)) + '</div>' +
        '<div class="ahl__tip-country">' + esc(best.city ? best.city + ', ' + best.country : best.country) + '</div>' +
        '<div class="ahl__tip-cmi">' + fmtInt(best.cmi) + ' <small>' + this.unit + '</small></div>' +
        '<div class="ahl__tip-date">' + fmtDate(best.date) + '</div>';
    }
    tip.innerHTML = html;
    tip.classList.add('is-visible');
    // measure, then flip below / clamp horizontally so it never leaves the map
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var below = clu.y - th - 16 < 0;
    var x = clamp(clu.x, tw / 2 + 6, this.cw - tw / 2 - 6);
    tip.style.left = x + 'px';
    tip.style.top = (below ? clu.y + 16 : clu.y) + 'px';
    tip.style.transform = below
      ? 'translate(-50%, 14px)'
      : 'translate(-50%, calc(-100% - 14px))';
  };
  AHLeaderboard.prototype.hideTip = function () {
    this.el.tip.classList.remove('is-visible');
    if (this._hoverRows) { this.markRows(this._hoverRows, false); this._hoverRows = null; }
  };

  AHLeaderboard.prototype.markRows = function (ids, on) {
    ids.forEach(function (id) {
      var row = this.el.rows.querySelector('.ahl__row[data-id="' + id + '"]');
      if (row) row.classList.toggle('is-active', on);
    }, this);
  };

  // list row hover -> highlight pin
  AHLeaderboard.prototype.setHighlight = function (id) {
    if (this.highlightId === id) return;
    this.highlightId = id;
    if (id < 0) this.hideTip();
    this.dirty = true;
    this.render();
  };

  // list row click/focus -> pan+zoom the map to that entry
  AHLeaderboard.prototype.focusEntry = function (id) {
    var e = this.entries[id];
    if (!e || e._lat == null) return;
    this.cancelAnim();
    this.highlightId = id;
    var uv = this.unitOf(e._lon, e._lat);
    var z = Math.max(this.zoom, 3.2);
    this.zoom = clamp(z, 1, MAX_ZOOM);
    this.pan.x = this.cw / 2 - uv.u * this.worldW * this.zoom;
    this.pan.y = this.ch / 2 - uv.v * this.worldH * this.zoom;
    this.clampPan();
    this.dirty = true;
    this.render();
  };

  // cluster pin click -> smoothly zoom-to-fit all its members into the clear
  // area left of the panel, so every point spreads out and stays visible
  AHLeaderboard.prototype.fitCluster = function (pin) {
    var ids = (pin.dataset.ids || '').split(',').map(Number);
    var items = ids.map(function (id) { return this.entries[id]; }, this)
      .filter(function (e) { return e && e._lat != null; });
    if (!items.length) return;

    var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    items.forEach(function (e) {
      var uv = this.unitOf(e._lon, e._lat);
      if (uv.u < minU) minU = uv.u; if (uv.u > maxU) maxU = uv.u;
      if (uv.v < minV) minV = uv.v; if (uv.v > maxV) maxV = uv.v;
    }, this);
    var centerU = (minU + maxU) / 2, centerV = (minV + maxV) / 2;

    // bbox in world PIXELS at zoom 1 (fraction * world dimension)
    var bw = (maxU - minU) * this.worldW;
    var bh = (maxV - minV) * this.worldH;

    // fit into the CLEAR box: [0 .. cw - inset] wide, full height
    var inset = this.panelInset();
    var boxW = this.cw - inset, boxH = this.ch;
    var pad = 0.72;                         // leave a comfortable margin

    var z;
    if (bw < 1 && bh < 1) {
      // truly coincident members: honest fit is undefined, zoom hard so the
      // deterministic jitter fans them out (degenerate branch only)
      z = clamp(Math.max(this.zoom * 4, 22), 1, MAX_ZOOM);
    } else {
      z = Math.min(boxW * pad / Math.max(bw, 1), boxH * pad / Math.max(bh, 1));
      z = clamp(z, this.zoom, MAX_ZOOM);    // don't zoom out; cap is last-resort
    }

    // center the bbox in the clear box (mirror of centerView's use of boxW)
    var tx = boxW / 2 - centerU * this.worldW * z;
    var ty = this.ch / 2 - centerV * this.worldH * z;
    this.animateView(z, tx, ty, 420);
  };

  // ---- smooth view animation (zoom + pan), cancel-safe ----
  AHLeaderboard.prototype.animateView = function (tz, tx, ty, dur) {
    var self = this;
    this.cancelAnim();
    var sz = this.zoom, sx = this.pan.x, sy = this.pan.y;
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    dur = dur || 400;
    function ease(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
    function step(now) {
      var p = clamp((now - t0) / dur, 0, 1), k = ease(p);
      self.zoom = sz + (tz - sz) * k;
      self.pan.x = sx + (tx - sx) * k;
      self.pan.y = sy + (ty - sy) * k;
      self.clampPan();
      self.dirty = true;
      self.render();
      self._animRaf = p < 1 ? requestAnimationFrame(step) : null;
    }
    this._animRaf = requestAnimationFrame(step);
  };
  AHLeaderboard.prototype.cancelAnim = function () {
    if (this._animRaf) { cancelAnimationFrame(this._animRaf); this._animRaf = null; }
  };

  // ---- light pan inertia (fling then decelerate) ----
  AHLeaderboard.prototype.glide = function () {
    var self = this;
    this.cancelAnim();
    var vx = clamp(this._vx || 0, -46, 46), vy = clamp(this._vy || 0, -46, 46);
    if (Math.hypot(vx, vy) < 1.5) return;   // slow drag -> no fling
    function step() {
      self.pan.x += vx; self.pan.y += vy;
      vx *= 0.87; vy *= 0.87;               // light friction -> short glide (~0.4s)
      self.clampPan(); self.dirty = true; self.render();
      self._animRaf = (Math.abs(vx) + Math.abs(vy) > 0.4) ? requestAnimationFrame(step) : null;
    }
    this._animRaf = requestAnimationFrame(step);
  };

  // ---- public API ----
  window.AHLeaderboard = {
    init: function (root, opts) {
      if (!root) return null;
      var inst = new AHLeaderboard(root, opts);
      inst.init();
      return inst;
    }
  };
})();
