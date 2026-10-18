/* 指数估值看板 · 前端逻辑
 * 数据由 scripts/fetch_data.py 生成，挂在 window.__VALUATION_DATA__
 * 指标：PE(TTM) / PB / 股息率 / 股息率-10Y国债利差 */
(function () {
  'use strict';

  var DATA = window.__VALUATION_DATA__;
  if (!DATA) {
    document.body.innerHTML = '<p style="padding:40px;font:16px sans-serif">未找到数据文件 web/data/app-data.js，请先运行 python scripts/fetch_data.py</p>';
    return;
  }

  var INDEX_COLORS = { '000300.SH': '#2563eb', '000510.SH': '#0d9488' };

  var METRICS = [
    { key: 'pe', label: '市盈率', tab: 'PE 市盈率', full: '市盈率 PE(TTM)', better: 'low', unit: '', digits: 2,
      hint: '↓ 越低越便宜' },
    { key: 'pb', label: '市净率', tab: 'PB 市净率', full: '市净率 PB', better: 'low', unit: '', digits: 2,
      hint: '↓ 越低越便宜' },
    { key: 'dy', label: '股息率', tab: '股息率', full: '股息率（近12个月）', better: 'high', unit: '%', digits: 2,
      hint: '↑ 越高越划算' },
    { key: 'spread', label: '股息率利差', tab: '股息率利差', full: '股息率利差', better: 'high', unit: '%', digits: 2,
      hint: '↑ 越高越划算' }
  ];

  var RANGES = [
    { key: 1, label: '近1年' },
    { key: 3, label: '近3年' },
    { key: 5, label: '近5年' },
    { key: 10, label: '近10年' },
    { key: 'all', label: '至今' }
  ];

  // 止盈线：综合分 ≤ value 视为进入止盈区，本周不加投（分数按 0 计）
  var STOPS = [
    { key: 'bull', label: '牛市极端', value: 10, pe: '99%', note: '只在泡沫级估值才停手' },
    { key: 'mid', label: '综合', value: 30, pe: '97%', note: '默认，兼顾牛熊' },
    { key: 'bear', label: '熊市极端', value: 45, pe: '94%', note: '弱市里更早停手' }
  ];

  var MARKETS = DATA.markets || [];

  var state = { index: DATA.indices[0].code, range: 3, metric: 'pe', stop: 'mid', ranges: {} };

  // 默认区间 = 该市场的全部数据范围
  MARKETS.forEach(function (m) {
    var first = m.rows[0][0], last = m.rows[m.rows.length - 1][0];
    state.ranges[m.code] = { from: first, to: last };
  });

  function marketOf(code) {
    for (var i = 0; i < MARKETS.length; i++) if (MARKETS[i].code === code) return MARKETS[i];
    return null;
  }

  var NK_FIELDS = {
    from: ['nkFromY', 'nkFromM', 'nkFromD'],
    to: ['nkToY', 'nkToM', 'nkToD']
  };

  function nkEl(side, i) {
    return document.getElementById(NK_FIELDS[side][i]);
  }

  // 解析用户输入：2000 / 2000-05 / 2000-05-06 / 2000/5/6，缺省补成区间首末
  function nkParseDate(str, isEnd) {
    var s = String(str || '').trim().replace(/[\/.]/g, '-').replace(/\s+/g, '');
    var m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    if (!m) return null;
    var y = +m[1], mo = m[2] ? +m[2] : null, d = m[3] ? +m[3] : null;
    if (y < 1600 || y > 2100) return null;
    if (mo === null) return isEnd ? y + '-12-31' : y + '-01-01';
    if (mo < 1 || mo > 12) return null;
    if (d === null) {
      var last = new Date(y, mo, 0).getDate();
      return isEnd ? y + '-' + pad(mo) + '-' + pad(last) : y + '-' + pad(mo) + '-01';
    }
    if (d < 1 || d > 31) return null;
    return y + '-' + pad(mo) + '-' + pad(d);
  }

  // 支持通过地址栏 hash 直达某个视图，例如 #000510.SH/10/pb 或 #N225/1989-12-29/2026-10-16
  (function readHash() {
    var parts = (location.hash || '').replace(/^#/, '').split('/');
    var mk = marketOf(parts[0]);
    if (mk) {
      state.index = mk.code;
      var a = nkParseDate(parts[1], false), b = nkParseDate(parts[2], true);
      if (a) state.ranges[mk.code].from = a;
      if (b) state.ranges[mk.code].to = b;
      return;
    }
    if (parts[0] && DATA.indices.some(function (i) { return i.code === parts[0]; })) state.index = parts[0];
    if (parts[1]) state.range = parts[1] === 'all' ? 'all' : (+parts[1] || state.range);
    if (parts[2] && METRICS.some(function (m) { return m.key === parts[2]; })) state.metric = parts[2];
    if (parts[3] && STOPS.some(function (s) { return s.key === parts[3]; })) state.stop = parts[3];
  })();

  /* ---------------- 数据准备 ---------------- */
  var bondDates = DATA.bonds.map(function (b) { return b[0]; });
  var bondVals = DATA.bonds.map(function (b) { return b[1]; });

  var us10Dates = (DATA.us10 || []).map(function (b) { return b[0]; });
  var us10Vals = (DATA.us10 || []).map(function (b) { return b[1]; });

  function us10At(date) {
    var lo = 0, hi = us10Dates.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (us10Dates[mid] <= date) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans >= 0 ? us10Vals[ans] : null;
  }

  function bondAt(date) {
    var lo = 0, hi = bondDates.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (bondDates[mid] <= date) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans >= 0 ? bondVals[ans] : null;
  }

  var SERIES = {};
  DATA.indices.forEach(function (idx) {
    SERIES[idx.code] = (idx.rows || []).map(function (r) {
      var y10 = bondAt(r[0]);
      var u10 = us10At(r[0]);
      var dy = r[4];
      return {
        date: r[0],
        close: r[1],
        pe: r[2],
        pb: r[3],
        dy: dy,
        y10: y10,
        us10: u10,
        spread: (dy != null && y10 != null) ? +(dy - y10).toFixed(4) : null,
        spreadUs: (dy != null && u10 != null) ? +(dy - u10).toFixed(4) : null,
        cnUs: (y10 != null && u10 != null) ? +(y10 - u10).toFixed(4) : null
      };
    });
  });

  /* ---------------- 工具函数 ---------------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function shiftYears(dateStr, years) {
    var p = dateStr.split('-');
    var y = +p[0] - years, m = +p[1], d = +p[2];
    var dim = new Date(y, m, 0).getDate();
    return y + '-' + pad(m) + '-' + pad(Math.min(d, dim));
  }

  function metricCfg(key) {
    for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === key) return METRICS[i];
    return METRICS[0];
  }

  function fmt(v, cfg) {
    if (v == null || isNaN(v)) return '--';
    return v.toFixed(cfg.digits);
  }

  function windowRows(rows, range) {
    if (range === 'all') return rows;
    var last = rows[rows.length - 1].date;
    var cut = shiftYears(last, range);
    for (var i = 0; i < rows.length; i++) if (rows[i].date >= cut) return rows.slice(i);
    return rows.slice();
  }

  function valuesOf(rows, key) {
    var out = [];
    for (var i = 0; i < rows.length; i++) if (rows[i][key] != null) out.push(rows[i][key]);
    return out;
  }

  function percentile(values, v) {
    if (!values.length) return null;
    var n = 0;
    for (var i = 0; i < values.length; i++) if (values[i] <= v) n++;
    return n / values.length * 100;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var base = Math.floor(pos), rest = pos - base;
    if (sorted[base + 1] != null) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  }

  function hexA(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function judge(cfg, pct) {
    if (pct == null) return { label: '--', tone: 'tone-mid' };
    var cheap = cfg.better === 'low' ? 100 - pct : pct;
    if (cfg.better === 'low') {
      if (cheap >= 80) return { label: '低估', tone: 'tone-good' };
      if (cheap >= 60) return { label: '偏低', tone: 'tone-good' };
      if (cheap >= 40) return { label: '中性', tone: 'tone-mid' };
      if (cheap >= 20) return { label: '偏高', tone: 'tone-warn' };
      return { label: '高估', tone: 'tone-bad' };
    }
    if (cfg.key === 'dy') {
      if (cheap >= 80) return { label: '股息率高', tone: 'tone-good' };
      if (cheap >= 60) return { label: '偏高', tone: 'tone-good' };
      if (cheap >= 40) return { label: '中性', tone: 'tone-mid' };
      if (cheap >= 20) return { label: '偏低', tone: 'tone-warn' };
      return { label: '股息率低', tone: 'tone-bad' };
    }
    if (cheap >= 80) return { label: '性价比高', tone: 'tone-good' };
    if (cheap >= 60) return { label: '偏高', tone: 'tone-good' };
      if (cheap >= 40) return { label: '中性', tone: 'tone-mid' };
    if (cheap >= 20) return { label: '偏低', tone: 'tone-warn' };
    return { label: '性价比低', tone: 'tone-bad' };
  }

  function stats(rows, key) {
    var vals = valuesOf(rows, key);
    if (!vals.length) return null;
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return {
      min: sorted[0], max: sorted[sorted.length - 1],
      p20: quantile(sorted, 0.2), p50: quantile(sorted, 0.5), p80: quantile(sorted, 0.8),
      mean: sum / vals.length,
      last: vals[vals.length - 1],
      pct: percentile(sorted, vals[vals.length - 1])
    };
  }

  /* ---------------- 控件渲染 ---------------- */
  var elKpis = document.getElementById('kpis');
  var elIndexTabs = document.getElementById('indexTabs');
  var elRange = document.getElementById('rangeGroup');
  var elMetricTabs = document.getElementById('metricTabs');

  document.getElementById('dataDate').textContent = DATA.meta.latestDate || '--';
  document.getElementById('dataStart').textContent =
    ((DATA.indices[0].rows[0] || [''])[0] || '').slice(0, 7) || '--';

  function renderIndexTabs() {
    var html = DATA.indices.map(function (idx) {
      var rows = SERIES[idx.code];
      var last = rows[rows.length - 1];
      return '<div class="index-tab' + (idx.code === state.index ? ' on' : '') + '" data-code="' + idx.code +
        '" style="--tab-accent:' + (INDEX_COLORS[idx.code] || '#2563eb') + '">' +
        '<span class="dot"></span>' +
        '<span><span class="it-name">' + idx.name + '</span><br><span class="it-code">' + idx.code + '</span></span>' +
        '<span class="it-pe">PE(TTM)<b>' + fmt(last.pe, metricCfg('pe')) + '</b></span>' +
        '</div>';
    }).join('');

    MARKETS.forEach(function (m) {
      var last = m.rows[m.rows.length - 1];
      html += '<div class="index-tab' + (state.index === m.code ? ' on' : '') + '" data-code="' + m.code +
        '" style="--tab-accent:' + (m.color || '#334155') + '">' +
        '<span class="dot"></span>' +
        '<span><span class="it-name">' + m.name + '</span><br><span class="it-code">' + m.code + ' · 定投</span></span>' +
        '<span class="it-pe">收盘<b>' + fmt(last[1], metricCfg('pe')) + '</b></span>' +
        '</div>';
    });
    elIndexTabs.innerHTML = html;
  }

  elRange.innerHTML = RANGES.map(function (r) {
    return '<button type="button" data-range="' + r.key + '">' + r.label + '</button>';
  }).join('');

  elMetricTabs.innerHTML = METRICS.map(function (m) {
    return '<button type="button" data-metric="' + m.key + '">' + m.tab + '</button>';
  }).join('');

  elIndexTabs.addEventListener('click', function (e) {
    var t = e.target.closest('.index-tab');
    if (!t) return;
    state.index = t.dataset.code;
    renderAll();
  });

  elRange.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.range = b.dataset.range === 'all' ? 'all' : +b.dataset.range;
    renderAll();
  });

  elMetricTabs.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.metric = b.dataset.metric;
    renderAll();
  });

  /* ---------------- 海外市场：日期输入 ---------------- */
  function nkReadSide(side) {
    var yEl = nkEl(side, 0), mEl = nkEl(side, 1), dEl = nkEl(side, 2);
    var y = parseInt(yEl.value, 10);
    if (!y || y < 1600 || y > 2100) return null;
    var isEnd = side === 'to';
    var m = parseInt(mEl.value, 10);
    if (!m) m = isEnd ? 12 : 1;
    if (m < 1 || m > 12) return null;
    var lastDay = new Date(y, m, 0).getDate();
    var d = parseInt(dEl.value, 10);
    if (!d) d = isEnd ? lastDay : 1;
    if (d < 1 || d > lastDay) return null;
    return y + '-' + pad(m) + '-' + pad(d);
  }

  function nkWriteSide(side, dateStr) {
    var p = dateStr.split('-');
    nkEl(side, 0).value = p[0];
    nkEl(side, 1).value = +p[1];
    nkEl(side, 2).value = +p[2];
  }

  function nkCommit() {
    var m = marketOf(state.index);
    if (!m) return;
    var r = state.ranges[m.code];
    var first = m.rows[0][0], last = m.rows[m.rows.length - 1][0];
    var a = nkReadSide('from') || r.from;
    var b = nkReadSide('to') || r.to;
    if (a < first) a = first;
    if (b > last) b = last;
    if (a > b) { var t = a; a = b; b = t; }
    r.from = a;
    r.to = b;
    renderAll();
  }

  function nkBad(el) {
    el.classList.add('bad');
    setTimeout(function () { el.classList.remove('bad'); }, 900);
  }

  function nkBind(side) {
    var yEl = nkEl(side, 0), mEl = nkEl(side, 1), dEl = nkEl(side, 2);
    [yEl, mEl, dEl].forEach(function (el, idx) {
      el.addEventListener('input', function () {
        el.value = el.value.replace(/[^\d]/g, '');
        if (el.value.length >= (+el.getAttribute('maxlength')) && idx < 2) {
          [mEl, dEl][idx].focus();
          [mEl, dEl][idx].select();
        }
      });
      el.addEventListener('change', function () {
        if (nkReadSide(side)) nkCommit();
        else {
          var m = marketOf(state.index);
          nkBad(el);
          if (m) nkWriteSide(side, side === 'from' ? state.ranges[m.code].from : state.ranges[m.code].to);
        }
      });
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (nkReadSide(side)) { nkCommit(); el.blur(); } else nkBad(el);
      });
      el.addEventListener('blur', function () {
        var m = marketOf(state.index);
        if (m) nkWriteSide(side, side === 'from' ? state.ranges[m.code].from : state.ranges[m.code].to);
      });
    });
  }
  nkBind('from');
  nkBind('to');

  /* ---------------- KPI ---------------- */
  function renderKpis(rows) {
    var html = METRICS.map(function (cfg) {
      var s = stats(rows, cfg.key);
      var j = judge(cfg, s ? s.pct : null);
      var unit = cfg.unit ? '<span class="unit">' + cfg.unit + '</span>' : '';
      var pctTxt = s ? s.pct.toFixed(1) + '%' : '--';
      var rangeTxt = s ? '区间 ' + fmt(s.min, cfg) + ' – ' + fmt(s.max, cfg) +
        ' · 中位 ' + fmt(s.p50, cfg) : '';
      var grad = cfg.better === 'low'
        ? 'linear-gradient(90deg,#34d399,#93c5fd 45%,#fca5a5)'
        : 'linear-gradient(90deg,#fca5a5,#93c5fd 55%,#34d399)';
      return '<div class="kpi">' +
        '<div class="kpi-top"><span class="kpi-name">' + cfg.full + '</span>' +
        '<span class="badge ' + j.tone + '">' + j.label + '</span></div>' +
        '<div class="kpi-value">' + (s ? fmt(s.last, cfg) : '--') + unit + '</div>' +
        '<div class="kpi-meta">区间分位 <b>' + pctTxt + '</b><span>· 均值 ' + (s ? fmt(s.mean, cfg) : '--') + '</span></div>' +
        '<div class="pct-track"><div class="pct-fill" style="width:' + (s ? s.pct : 0) +
        '%;background:' + grad + '"></div><div class="pct-dot" style="left:' + (s ? s.pct : 0) + '%"></div></div>' +
        '<div class="kpi-range"><span>' + rangeTxt + '</span></div>' +
        '<div class="kpi-hint ' + (cfg.better === 'low' ? 'low' : 'high') + '">' + cfg.hint + '</div>' +
        '</div>';
    }).join('');
    elKpis.innerHTML = html;
  }

  /* ---------------- 本周加投建议 ---------------- */
  var BASE_KEY = 'valuation.baseAddOn';

  function getBase() {
    try {
      var v = +(localStorage.getItem(BASE_KEY) || 100);
      return isFinite(v) && v > 0 ? v : 100;
    } catch (e) { return 100; }
  }

  // 区间综合分：0.3×(100−PE分位) + 0.2×(100−PB分位) + 0.5×利差分位（分位按所选区间计算）
  function scoreOf(idx, range) {
    var rows = windowRows(SERIES[idx.code], range);
    var peS = stats(rows, 'pe');
    var pbS = stats(rows, 'pb');
    var spS = stats(rows, 'spread');
    if (!peS || !pbS || !spS) return null;
    return {
      pePct: peS.pct,
      pbPct: pbS.pct,
      spPct: spS.pct,
      score: 0.3 * (100 - peS.pct) + 0.2 * (100 - pbS.pct) + 0.5 * spS.pct
    };
  }

  function stopCfg() {
    for (var i = 0; i < STOPS.length; i++) if (STOPS[i].key === state.stop) return STOPS[i];
    return STOPS[1];
  }

  // 连续档位：以 S 为横轴分段线性插值，金额按 10 元取整（比原来 50 元一档细腻得多）
  // 锚点沿用旧档位带的中点，保证整体“越便宜买越多”的形态不变
  var MULT_ANCHORS = [
    [0, 0.3], [22.5, 0.4], [37.5, 0.6], [52.5, 1.0],
    [67.5, 1.5], [80, 2.0], [92, 2.5], [100, 2.7]
  ];

  function multFor(score) {
    for (var i = 1; i < MULT_ANCHORS.length; i++) {
      if (score <= MULT_ANCHORS[i][0]) {
        var a = MULT_ANCHORS[i - 1], b = MULT_ANCHORS[i];
        var t = (score - a[0]) / (b[0] - a[0]);
        return a[1] + t * (b[1] - a[1]);
      }
    }
    return MULT_ANCHORS[MULT_ANCHORS.length - 1][1];
  }

  function addOnAmount(score, base, stopValue) {
    if (score <= stopValue) return 0;
    return Math.max(10, Math.round(base * multFor(score) / 10) * 10);
  }

  function scoreJudge(s) {
    if (s >= 85) return { label: '很便宜', tone: 'tone-good' };
    if (s >= 75) return { label: '便宜', tone: 'tone-good' };
    if (s >= 60) return { label: '偏便宜', tone: 'tone-good' };
    if (s >= 45) return { label: '中性', tone: 'tone-mid' };
    if (s >= 30) return { label: '偏贵', tone: 'tone-warn' };
    return { label: '贵', tone: 'tone-bad' };
  }

  // ---------- 回测：每天 10 元 + 每周按建议加投 ----------
  var SIM_CACHE = {};

  function weekKey(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return 0;
    var day = (d.getDay() + 6) % 7;          // 周一 = 0
    d.setDate(d.getDate() - day + 3);        // 本周四
    var firstThu = new Date(d.getFullYear(), 0, 4);
    var w = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
    return d.getFullYear() * 100 + w;
  }

  // 用「价格涨跌 + 当日股息率折算」近似全收益序列，避免只用价格指数低估收益
  function trSeries(idx) {
    var rows = SERIES[idx.code];
    var tr = new Array(rows.length);
    var v = 1;
    tr[0] = 1;
    for (var i = 1; i < rows.length; i++) {
      var p = rows[i - 1].close, c = rows[i].close;
      var r = (p && c) ? c / p - 1 : 0;
      var d = rows[i].dy || 0;
      v *= (1 + r + d / 100 / 365);
      tr[i] = v;
    }
    return tr;
  }

  // 只使用 i 及之前的数据打分（无未来函数）
  function scoreAtIdx(code, i, range) {
    var rows = SERIES[code];
    var cut = range === 'all' ? rows[0].date : shiftYears(rows[i].date, range);
    var lo = i;
    while (lo > 0 && rows[lo].date >= cut) lo--;
    if (i - lo < 60) return null;
    var cur = rows[i];
    var pe = [], pb = [], sp = [];
    for (var k = lo + 1; k <= i; k++) {
      if (rows[k].pe != null) pe.push(rows[k].pe);
      if (rows[k].pb != null) pb.push(rows[k].pb);
      if (rows[k].spread != null) sp.push(rows[k].spread);
    }
    if (!pe.length || !pb.length || !sp.length || cur.pe == null || cur.pb == null || cur.spread == null) return null;
    var q = function (arr, v) {
      var c = 0;
      for (var j = 0; j < arr.length; j++) if (arr[j] <= v) c++;
      return c / arr.length * 100;
    };
    return 0.3 * (100 - q(pe, cur.pe)) + 0.2 * (100 - q(pb, cur.pb)) + 0.5 * q(sp, cur.spread);
  }

  function xirr(flows) {
    var lo = -0.95, hi = 3;
    for (var it = 0; it < 80; it++) {
      var mid = (lo + hi) / 2, npv = 0;
      for (var i = 0; i < flows.length; i++) {
        npv += flows[i][1] / Math.pow(1 + mid, flows[i][0] / 365);
      }
      if (npv > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function simulate(idx, range, base, stopValue) {
    var key = idx.code + '|' + range + '|' + base + '|' + stopValue;
    if (SIM_CACHE[key]) return SIM_CACHE[key];
    var rows = SERIES[idx.code], tr = trSeries(idx);
    var end = rows.length - 1;
    var startDate = range === 'all' ? rows[0].date : shiftYears(rows[end].date, range);
    var start = 0;
    for (var i = 0; i < rows.length; i++) { if (rows[i].date >= startDate) { start = i; break; } }

    var units = 0, invested = 0, flows = [], lastWeek = 0;
    var t0 = new Date(rows[start].date + 'T00:00:00').getTime();
    for (var j = start; j <= end; j++) {
      var amt = 10;                                   // 每日定投
      var wk = weekKey(rows[j].date);
      if (wk !== lastWeek) {                          // 每周第一个交易日加投
        lastWeek = wk;
        var s = scoreAtIdx(idx.code, j, range);
        if (s != null && s > stopValue) amt += addOnAmount(s, base, stopValue);
      }
      units += amt / tr[j];
      invested += amt;
      flows.push([(new Date(rows[j].date + 'T00:00:00').getTime() - t0) / 86400000, -amt]);
    }
    var value = units * tr[end];
    flows.push([(new Date(rows[end].date + 'T00:00:00').getTime() - t0) / 86400000, value]);
    var res = { xirr: xirr(flows), invested: invested, value: value };
    SIM_CACHE[key] = res;
    return res;
  }

  function renderAdvice() {
    var base = getBase();
    var stop = stopCfg();
    var idx = DATA.indices.filter(function (i) { return i.code === state.index; })[0] || DATA.indices[0];
    document.getElementById('adviceDate').textContent = DATA.meta.latestDate || '--';

    // 止盈线提示
    var stopNote = document.getElementById('stopNote');
    if (stopNote) {
      stopNote.innerHTML = '综合分 ≤ <b>' + stop.value + '</b> 触发（约 PE 分位 ≥ ' + stop.pe + '）· ' + stop.note;
    }

    var cur = scoreOf(idx, state.range);
    if (!cur) { document.getElementById('adviceCols').innerHTML = ''; return; }
    var inStop = cur.score <= stop.value;
    var amount = inStop ? 0 : addOnAmount(cur.score, base, stop.value);
    var j = inStop ? { label: '止盈区', tone: 'tone-bad' } : scoreJudge(cur.score);
    var accent = INDEX_COLORS[idx.code] || '#2563eb';
    var gap = cur.score - stop.value;
    var gapTxt = inStop
      ? '已低于止盈线 ' + Math.abs(gap).toFixed(1) + ' 分'
      : '距止盈线还有 ' + gap.toFixed(1) + ' 分';

    var rowsHtml = RANGES.map(function (r) {
      var s = scoreOf(idx, r.key);
      if (!s) return '';
      var hit = s.score <= stop.value;
      var isActive = String(r.key) === String(state.range);
      var amt = hit ? 0 : addOnAmount(s.score, base, stop.value);
      var cls = [];
      if (isActive) cls.push('on');
      if (hit && !isActive) cls.push('dead');   // 止盈线以下：灰显，不可达
      var sim = simulate(idx, r.key, base, stop.value);
      var xr = sim.xirr * 100;
      var simple = (sim.value / sim.invested - 1) * 100;
      return '<tr' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' +
        '<td>' + r.label + '</td>' +
        '<td class="num">' + s.pePct.toFixed(1) + '%</td>' +
        '<td class="num">' + s.pbPct.toFixed(1) + '%</td>' +
        '<td class="num">' + s.spPct.toFixed(1) + '%</td>' +
        '<td class="num">' + (hit ? '<span class="strike">' + s.score.toFixed(1) + '</span> 0' : s.score.toFixed(1)) + '</td>' +
        '<td class="num">' + (hit
          ? (isActive ? '<span class="stop-tag">止盈 · 0</span>' : '<span class="dead-tag">止盈线以下</span>')
          : amt + ' 元') + '</td>' +
        '<td class="num ' + (xr >= 0 ? 'up' : 'down') + '">' + (xr >= 0 ? '+' : '') + xr.toFixed(1) + '%' +
        '<div class="sub">累计 ' + (simple >= 0 ? '+' : '') + simple.toFixed(1) + '%</div></td>' +
        '</tr>';
    }).join('');

    var mult = inStop ? 0 : multFor(cur.score);

    var html = '<div class="advice-col" style="--col-accent:' + accent + '">' +
      '<div class="advice-col-head">' +
      '<span class="advice-col-name"><i></i>' + idx.name + '</span>' +
      '<span class="badge ' + j.tone + '">' + j.label + '</span>' +
      '</div>' +      '<div class="advice-col-main">' +
      '<div class="advice-score-wrap">' +
      '<span class="advice-col-label">本周打分</span>' +
      '<div class="advice-col-score">' +
      (inStop ? '<span class="strike">' + cur.score.toFixed(1) + '</span><i>→</i>0' : cur.score.toFixed(1)) +
      '</div>' +
      '<span class="advice-col-max">满分100</span>' +
      '<div class="advice-col-gap' + (inStop ? ' hit' : '') + '">' + gapTxt + '</div>' +
      '</div>' +
      '<div class="advice-col-amount">' +
      '<span class="lbl">本周建议加投</span>' +
      '<span class="val' + (inStop ? ' stop' : '') + '"><b>' + (inStop ? 0 : amount) + '</b><i>元</i></span>' +
      (inStop ? '' : '<span class="mult">×' + mult.toFixed(1) + '</span>') +
      '</div>' +
      '</div>' +
      '<div class="advice-col-sub">PE分位 ' + cur.pePct.toFixed(1) + '% · PB分位 ' + cur.pbPct.toFixed(1) +
      '% · 利差分位 ' + cur.spPct.toFixed(1) + '% · 按' +
      (state.range === 'all' ? '全部历史' : '近' + state.range + '年') + '计算</div>' +
      '<table class="advice-table"><thead><tr><th>区间</th><th>PE分位</th><th>PB分位</th><th>利差分位</th><th>综合分</th><th>本周加投</th><th>年化收益</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table>' +
      '<div class="advice-foot">年化收益：<b>每天定投 10 元 + 本周建议</b>，买入后一直持有、不卖出；' +
      '含股息（按当日股息率折算）、未计费用；每次打分只使用当日及之前的数据，不含未来信息。<br>' +
      '年化为资金加权（XIRR）：近1年这一档资金分 12 个月投入、平均持有期只有约 4 个月，' +
      '盈亏都会被放大成年化值，看 3 年及以上更稳定。</div>' +
      '</div>';

    document.getElementById('adviceCols').innerHTML = html;
  }

  var elStop = document.getElementById('stopGroup');
  elStop.innerHTML = STOPS.map(function (s) {
    return '<button type="button" data-stop="' + s.key + '">' + s.label + '</button>';
  }).join('');
  elStop.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.stop = b.dataset.stop;
    renderAll();
  });

  var elAdviceBase = document.getElementById('adviceBase');
  elAdviceBase.value = getBase();
  elAdviceBase.addEventListener('input', function () {
    var v = +elAdviceBase.value;
    if (!isFinite(v) || v <= 0) return;
    try { localStorage.setItem(BASE_KEY, v); } catch (e) { /* ignore */ }
    renderAdvice();
  });

  /* ---------------- 图表 ---------------- */
  var charts = {
    main: echarts.init(document.getElementById('mainChart')),
    kline: echarts.init(document.getElementById('klineChart')),
    spread: echarts.init(document.getElementById('spreadChart')),
    pct: echarts.init(document.getElementById('pctChart')),
    dist: echarts.init(document.getElementById('distChart'))
  };

  var AXIS_TEXT = '#94a3b8';
  var SPLIT_LINE = '#eef2f7';
  window.__charts = charts;

  function baseTooltip(extra) {
    return {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: '#334155' }, crossStyle: { color: '#cbd5e1' } },
      backgroundColor: 'rgba(15,23,42,.93)',
      borderWidth: 0,
      padding: [10, 12],
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 10px 26px -12px rgba(0,0,0,.5);',
      formatter: extra
    };
  }

  function timeAxis(dates) {
    return {
      type: 'time',
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisTick: { show: false },
      axisLabel: {
        color: AXIS_TEXT,
        fontSize: 11,
        hideOverlap: true,
        formatter: function (v) {
          var d = new Date(v);
          return d.getFullYear() + '-' + pad(d.getMonth() + 1);
        }
      },
      splitLine: { show: false }
    };
  }

  function renderMain(rows, cfg, accent) {
    if (cfg.key === 'spread') accent = '#7c3aed';
    var dates = rows.map(function (r) { return r.date; });
    var seriesData = rows.map(function (r) {
      return r[cfg.key] == null ? null : [r.date, r[cfg.key]];
    });
    var closeData = rows.map(function (r) { return [r.date, r.close]; });
    var s = stats(rows, cfg.key);
    var sortedVals = valuesOf(rows, cfg.key).sort(function (a, b) { return a - b; });
    var rangeLabel = state.range === 'all' ? '全部历史' : '近' + state.range + '年';
    var labelBase = {
      fontSize: 10.5, position: 'insideStartTop', padding: [2, 5],
      borderRadius: 4, backgroundColor: 'rgba(255,255,255,.86)'
    };

    var markLines = [];
    if (s) {
      markLines = [
        { yAxis: s.p20, lineStyle: { color: '#22c55e', type: 'dashed', width: 1, opacity: .75 },
          label: Object.assign({}, labelBase, { formatter: '20%分位 ' + fmt(s.p20, cfg), color: '#16a34a' }) },
        { yAxis: s.p50, lineStyle: { color: '#94a3b8', type: 'dashed', width: 1, opacity: .75 },
          label: Object.assign({}, labelBase, { formatter: '中位 ' + fmt(s.p50, cfg), color: '#64748b' }) },
        { yAxis: s.p80, lineStyle: { color: '#f97316', type: 'dashed', width: 1, opacity: .75 },
          label: Object.assign({}, labelBase, { formatter: '80%分位 ' + fmt(s.p80, cfg), color: '#ea580c' }) }
      ];
    }

    charts.main.setOption({
      animationDuration: 500,
      grid: { left: 58, right: 66, top: 30, bottom: 34 },
      legend: {
        show: true, top: 0, right: 8, itemWidth: 14, itemHeight: 8, itemGap: 16,
        textStyle: { color: '#64748b', fontSize: 11.5 },
        data: [cfg.full, '指数点位']
      },
      tooltip: baseTooltip(function (params) {
        if (!params.length) return '';
        var out = '<div style="font-weight:600;margin-bottom:6px">' + params[0].axisValueLabel + '</div>';
        var metricVal = null;
        params.forEach(function (p) {
          if (p.value == null) return;
          var v = Array.isArray(p.value) ? p.value[1] : p.value;
          var unit = (p.seriesName === '指数点位') ? '' : cfg.unit;
          if (p.seriesName === cfg.full) metricVal = v;
          out += '<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7">' +
            '<span style="color:#cbd5e1">' + p.marker + p.seriesName + '</span>' +
            '<b style="font-variant-numeric:tabular-nums">' + Number(v).toFixed(2) + unit + '</b></div>';
        });
        if (metricVal != null && sortedVals.length) {
          var pct = percentile(sortedVals, metricVal);
          out += '<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7;' +
            'margin-top:4px;padding-top:5px;border-top:1px solid rgba(148,163,184,.25)">' +
            '<span style="color:#cbd5e1">区间分位<span style="color:#94a3b8;font-size:11px">（' + rangeLabel + '）</span></span>' +
            '<b style="font-variant-numeric:tabular-nums">' + pct.toFixed(1) + '%</b></div>';
        }
        return out;
      }),
      xAxis: timeAxis(dates),
      yAxis: [
        {
          type: 'value', scale: true, position: 'left',
          axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: function (v) { return v.toFixed(cfg.digits); } },
          splitLine: { lineStyle: { color: SPLIT_LINE } }
        },
        {
          type: 'value', scale: true, position: 'right',
          axisLabel: { color: '#cbd5e1', fontSize: 11 },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: '指数点位', type: 'line', yAxisIndex: 1, data: closeData,
          showSymbol: false, symbol: 'none', smooth: false,
          lineStyle: { width: 1.2, color: '#cbd5e1', type: 'dashed' },
          emphasis: { disabled: true }, z: 1
        },
        {
          name: cfg.full, type: 'line', yAxisIndex: 0, data: seriesData,
          showSymbol: false, symbol: 'none', smooth: false, connectNulls: false,
          sampling: 'lttb',
          lineStyle: { width: 2.1, color: accent },
          itemStyle: { color: accent },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: hexA(accent, .26) },
              { offset: 1, color: hexA(accent, .02) }
            ])
          },
          markLine: {
            symbol: 'none', silent: true, animation: false,
            data: markLines
          },
          z: 3
        }
      ]
    }, true);
  }

  var KUP = '#e11d48';
  var KDOWN = '#16a34a';

  function movingAverage(values, n) {
    var out = [], sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      out.push(i >= n - 1 ? +(sum / n).toFixed(2) : null);
    }
    return out;
  }

  function renderKline(idx) {
    var all = idx.ohlc || [];
    if (!all.length) { charts.kline.clear(); return; }
    var last = all[all.length - 1][0];
    var cut = state.range === 'all' ? '' : shiftYears(last, state.range);
    var start = 0;
    for (var i = 0; i < all.length; i++) { if (all[i][0] >= cut) { start = i; break; } }

    var closesAll = all.map(function (r) { return r[4]; });
    var ma20All = movingAverage(closesAll, 20);
    var ma60All = movingAverage(closesAll, 60);

    var view = all.slice(start);
    var dates = view.map(function (r) { return r[0]; });
    var monthLabels = dates.map(function (d, i) {
      return (i === 0 || d.slice(0, 7) !== dates[i - 1].slice(0, 7)) ? d.slice(0, 7) : '';
    });
    var candles = view.map(function (r) { return [r[1], r[4], r[3], r[2]]; }); // 开, 收, 低, 高
    var ma20 = ma20All.slice(start);
    var ma60 = ma60All.slice(start);
    var vols = view.map(function (r) {
      return {
        value: r[5],
        itemStyle: { color: r[4] >= r[1] ? hexA(KUP, .6) : hexA(KDOWN, .6) }
      };
    });

    charts.kline.setOption({
      animation: false,
      legend: {
        show: true, top: 0, right: 8, itemWidth: 14, itemHeight: 2, itemGap: 14,
        textStyle: { color: '#64748b', fontSize: 11.5 },
        data: ['MA20', 'MA60']
      },
      grid: [
        { left: 58, right: 20, top: 26, height: '58%' },
        { left: 58, right: 20, top: '73%', height: '16%' }
      ],
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { backgroundColor: '#334155' }, crossStyle: { color: '#cbd5e1' } },
        backgroundColor: 'rgba(15,23,42,.93)', borderWidth: 0, padding: [10, 12],
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        extraCssText: 'border-radius:10px;',
        formatter: function (params) {
          var p = params[0];
          if (!p) return '';
          var r = view[p.dataIndex];
          if (!r) return '';
          var prev = p.dataIndex > 0 ? view[p.dataIndex - 1][4] : r[1];
          var chg = (r[4] - prev) / prev * 100;
          var color = chg >= 0 ? '#fb7185' : '#4ade80';
          var row = function (k, v) {
            return '<div style="display:flex;justify-content:space-between;gap:22px;line-height:1.7">' +
              '<span style="color:#cbd5e1">' + k + '</span><b style="font-variant-numeric:tabular-nums">' + v + '</b></div>';
          };
          return '<div style="font-weight:600;margin-bottom:6px">' + r[0] + '</div>' +
            row('开盘', r[1].toFixed(2)) + row('最高', r[2].toFixed(2)) +
            row('最低', r[3].toFixed(2)) + row('收盘', r[4].toFixed(2)) +
            row('涨跌幅', '<span style="color:' + color + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</span>') +
            row('成交额', r[5].toFixed(0) + ' 亿');
        }
      },
      xAxis: [
        {
          type: 'category', data: dates, boundaryGap: true,
          axisLine: { lineStyle: { color: '#e2e8f0' } }, axisTick: { show: false },
          axisLabel: { show: false }, splitLine: { show: false }
        },
        {
          type: 'category', gridIndex: 1, data: dates, boundaryGap: true,
          axisLine: { lineStyle: { color: '#e2e8f0' } }, axisTick: { show: false },
          axisLabel: {
            color: AXIS_TEXT, fontSize: 11, interval: 0, hideOverlap: true,
            formatter: function (v, i) { return monthLabels[i] || ''; }
          },
          splitLine: { show: false }
        }
      ],
      yAxis: [
        {
          type: 'value', scale: true, gridIndex: 0,
          axisLabel: { color: AXIS_TEXT, fontSize: 11 },
          splitLine: { lineStyle: { color: SPLIT_LINE } }
        },
        {
          type: 'value', gridIndex: 1, splitNumber: 2,
          axisLabel: { color: '#cbd5e1', fontSize: 10, formatter: '{value}亿' },
          splitLine: { show: false }
        }
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100, minValueSpan: 20 }
      ],
      series: [
        {
          name: '日K', type: 'candlestick', data: candles, xAxisIndex: 0, yAxisIndex: 0,
          itemStyle: {
            color: KUP, color0: KDOWN, borderColor: KUP, borderColor0: KDOWN
          },
          z: 3
        },
        {
          name: 'MA20', type: 'line', data: ma20, xAxisIndex: 0, yAxisIndex: 0,
          showSymbol: false, smooth: true, connectNulls: false,
          lineStyle: { width: 1.2, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' }, z: 4
        },
        {
          name: 'MA60', type: 'line', data: ma60, xAxisIndex: 0, yAxisIndex: 0,
          showSymbol: false, smooth: true, connectNulls: false,
          lineStyle: { width: 1.2, color: '#6366f1' }, itemStyle: { color: '#6366f1' }, z: 4
        },
        {
          name: '成交额', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1,
          barWidth: '70%'
        }
      ]
    }, true);

    document.getElementById('klineNote').textContent =
      idx.name + ' · 日线 · ' + dates[0] + ' 至 ' + dates[dates.length - 1] +
      ' · 共 ' + dates.length + ' 根 · 红涨绿跌';
  }

  function renderSpread(rows, accent) {
    var dy = [], y10 = [], u10 = [], sp = [], spUs = [], cnUs = [];
    var lookup = {};
    rows.forEach(function (r) {
      lookup[r.date] = r;
      if (r.dy != null) dy.push([r.date, r.dy]);
      if (r.y10 != null) y10.push([r.date, r.y10]);
      if (r.us10 != null) u10.push([r.date, r.us10]);
      if (r.spread != null) sp.push([r.date, r.spread]);
      if (r.spreadUs != null) spUs.push([r.date, r.spreadUs]);
      if (r.cnUs != null) cnUs.push([r.date, r.cnUs]);
    });

    function dateKey(ts) {
      var d = new Date(ts);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    charts.spread.setOption({
      animationDuration: 500,
      legend: {
        show: true, top: 0, left: 0, itemWidth: 12, itemHeight: 8, itemGap: 14,
        textStyle: { color: '#64748b', fontSize: 11.5 }
      },
      grid: [
        { left: 52, right: 16, top: 34, height: '36%' },
        { left: 52, right: 16, top: '60%', height: '26%' }
      ],
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: baseTooltip(function (params) {
        if (!params.length) return '';
        var key = dateKey(params[0].axisValue);
        var r = lookup[key];
        if (!r) return '';
        var line = function (name, val, color) {
          return '<div style="display:flex;justify-content:space-between;gap:22px;line-height:1.75">' +
            '<span style="color:#cbd5e1"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;' +
            'background:' + color + ';margin-right:6px"></i>' + name + '</span>' +
            '<b style="font-variant-numeric:tabular-nums">' + (val == null ? '--' : val.toFixed(2) + '%') + '</b></div>';
        };
        return '<div style="font-weight:600;margin-bottom:6px">' + key + '</div>' +
          line('股息率', r.dy, accent) +
          line('中国10年期国债', r.y10, '#94a3b8') +
          line('美国10年期国债', r.us10, '#f87171') +
          '<div style="border-top:1px solid rgba(148,163,184,.25);margin:5px 0"></div>' +
          line('股息率 − 中债', r.spread, '#7c3aed') +
          line('股息率 − 美债', r.spreadUs, '#0ea5e9') +
          line('中债 − 美债', r.cnUs, '#f59e0b');
      }),
      xAxis: [
        Object.assign(timeAxis(), { gridIndex: 0, axisLabel: { show: false } }),
        Object.assign(timeAxis(), { gridIndex: 1 })
      ],
      yAxis: [
        {
          type: 'value', scale: true, gridIndex: 0,
          axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: '{value}%' },
          splitLine: { lineStyle: { color: SPLIT_LINE } }
        },
        {
          type: 'value', scale: true, gridIndex: 1, splitNumber: 3,
          axisLabel: { color: '#a78bfa', fontSize: 10, formatter: '{value}%' },
          splitLine: { lineStyle: { color: SPLIT_LINE, opacity: .6 } }
        }
      ],
      series: [
        {
          name: '股息率', type: 'line', data: dy, xAxisIndex: 0, yAxisIndex: 0,
          showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 2.1, color: accent }, itemStyle: { color: accent }, z: 3
        },
        {
          name: '中国10Y', type: 'line', data: y10, xAxisIndex: 0, yAxisIndex: 0,
          showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 1.5, color: '#94a3b8', type: 'dashed' }, itemStyle: { color: '#94a3b8' }, z: 2
        },
        {
          name: '美国10Y', type: 'line', data: u10, xAxisIndex: 0, yAxisIndex: 0,
          showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 1.5, color: '#f87171', type: 'dashed' }, itemStyle: { color: '#f87171' }, z: 2
        },
        {
          name: '股息率−中债', type: 'line', data: sp, xAxisIndex: 1, yAxisIndex: 1,
          showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 1.5, color: '#7c3aed' }, itemStyle: { color: '#7c3aed' },
          z: 3
        },
        {
          name: '股息率−美债', type: 'line', data: spUs, xAxisIndex: 1, yAxisIndex: 1,
          showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 1.5, color: '#0ea5e9' }, itemStyle: { color: '#0ea5e9' },
          z: 2
        },
        {
          name: '中债−美债', type: 'line', data: cnUs, xAxisIndex: 1, yAxisIndex: 1,
          showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 1.5, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' },
          markLine: {
            symbol: 'none', silent: true, animation: false,
            data: [{ yAxis: 0, lineStyle: { color: '#cbd5e1', width: 1 }, label: { show: false } }]
          },
          z: 1
        }
      ]
    }, true);
  }

  function renderPct(rows, accent) {
    var sp = valuesOf(rows, 'spread');
    var sorted = sp.slice().sort(function (a, b) { return a - b; });
    var raw = [];
    rows.forEach(function (r) {
      if (r.spread == null) return;
      raw.push([r.date, percentile(sorted, r.spread)]);
    });
    // 5 日平滑，避免利差在分位线上反复穿越造成的毛刺
    var data = raw.map(function (p, i) {
      var from = Math.max(0, i - 4);
      var sum = 0, n = 0;
      for (var j = from; j <= i; j++) { sum += raw[j][1]; n++; }
      return [p[0], sum / n];
    });
    var lastPct = raw.length ? raw[raw.length - 1][1] : null;

    charts.pct.setOption({
      animationDuration: 500,
      grid: { left: 46, right: 52, top: 24, bottom: 30 },
      tooltip: baseTooltip(function (params) {
        if (!params.length || params[0].value == null) return '';
        var p = params[0];
        return '<div style="font-weight:600;margin-bottom:4px">' + p.axisValueLabel + '</div>' +
          '<div style="display:flex;justify-content:space-between;gap:18px">' +
          '<span style="color:#cbd5e1">利差分位(5日均)</span><b>' + Number(p.value[1]).toFixed(1) + '%</b></div>';
      }),
      xAxis: timeAxis(),
      yAxis: {
        type: 'value', min: 0, max: 100,
        axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: '{value}%' },
        splitLine: { lineStyle: { color: SPLIT_LINE } }
      },
      series: [{
        name: '利差分位', type: 'line', data: data, showSymbol: false, sampling: 'lttb',
        lineStyle: { width: 1.9, color: '#7c3aed' }, itemStyle: { color: '#7c3aed' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexA('#7c3aed', .20) },
            { offset: 1, color: hexA('#7c3aed', .02) }
          ])
        },
        markArea: {
          silent: true, animation: false,
          data: [
            [{ yAxis: 0, itemStyle: { color: 'rgba(22,163,74,.06)' }, label: { show: false } }, { yAxis: 20 }],
            [{ yAxis: 80, itemStyle: { color: 'rgba(225,29,72,.05)' }, label: { show: false } }, { yAxis: 100 }]
          ]
        },
        markLine: {
          symbol: 'none', silent: true, animation: false,
          data: [
            { yAxis: 50, lineStyle: { color: '#cbd5e1', type: 'dashed', width: 1 },
              label: { formatter: '50%', color: '#94a3b8', fontSize: 10, backgroundColor: 'rgba(255,255,255,.8)', padding: [1, 3] } },
            { yAxis: 20, lineStyle: { color: 'rgba(22,163,74,.5)', type: 'dotted', width: 1 }, label: { show: false } },
            { yAxis: 80, lineStyle: { color: 'rgba(225,29,72,.45)', type: 'dotted', width: 1 }, label: { show: false } }
          ]
        },
        markPoint: lastPct == null ? undefined : {
          symbol: 'circle', symbolSize: 9,
          itemStyle: { color: '#7c3aed', borderColor: '#fff', borderWidth: 2 },
          label: {
            show: true, position: 'left', distance: 8,
            formatter: lastPct.toFixed(1) + '%',
            color: '#6d28d9', fontWeight: 600, fontSize: 11
          },
          data: [{ coord: data[data.length - 1] }]
        },
        z: 3
      }]
    }, true);
  }

  function renderDist(rows) {
    var sp = valuesOf(rows, 'spread');
    if (!sp.length) { charts.dist.clear(); return; }
    var min = Math.min.apply(null, sp), max = Math.max.apply(null, sp);
    var bins = 42;
    var step = (max - min) / bins || 0.01;
    var counts = new Array(bins).fill(0);
    sp.forEach(function (v) {
      var i = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / step)));
      counts[i]++;
    });
    var labels = counts.map(function (_, i) { return (min + step * i).toFixed(2); });
    var cur = sp[sp.length - 1];
    var pct = percentile(sp.slice().sort(function (a, b) { return a - b; }), cur);

    var data = counts.map(function (c, i) {
      var mid = min + step * (i + 0.5);
      var isCur = mid - step / 2 <= cur && cur <= mid + step / 2;
      return {
        value: c,
        itemStyle: {
          color: isCur ? 'rgba(124,58,237,.85)' : 'rgba(124,58,237,.22)',
          borderRadius: [3, 3, 0, 0]
        }
      };
    });

    charts.dist.setOption({
      animationDuration: 500,
      grid: { left: 44, right: 20, top: 30, bottom: 30 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(15,23,42,.93)', borderWidth: 0,
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        formatter: function (params) {
          if (!params.length) return '';
          var p = params[0];
          var lo = (min + step * p.dataIndex).toFixed(2);
          var hi = (min + step * (p.dataIndex + 1)).toFixed(2);
          return '利差 ' + lo + '%~' + hi + '%<br>天数 <b>' + p.value + '</b> 天';
        }
      },
      xAxis: {
        type: 'category', data: labels, boundaryGap: true,
        axisLabel: {
          color: AXIS_TEXT, fontSize: 10.5, hideOverlap: true,
          formatter: function (v, i) { return i % 6 === 0 ? v + '%' : ''; }
        },
        axisLine: { lineStyle: { color: '#e2e8f0' } }, axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        name: '天数', nameTextStyle: { color: '#cbd5e1', fontSize: 10.5 },
        axisLabel: { color: AXIS_TEXT, fontSize: 10.5 },
        splitLine: { lineStyle: { color: SPLIT_LINE } }
      },
      series: [{
        type: 'bar', data: data, barWidth: '82%',
        markLine: {
          symbol: 'none', silent: true, animation: false,
          data: [{
            xAxis: Math.min(bins - 1, Math.max(0, Math.floor((cur - min) / step))),
            lineStyle: { color: '#0f172a', width: 1.6, type: 'solid' },
            label: {
              formatter: '当前 ' + cur.toFixed(2) + '% · 分位 ' + pct.toFixed(1) + '%',
              position: 'end', rotate: 0, distance: 6,
              color: '#0f172a', fontWeight: 600, fontSize: 11,
              backgroundColor: 'rgba(255,255,255,.9)', padding: [2, 5], borderRadius: 4
            }
          }]
        }
      }]
    }, true);

    document.getElementById('distNote').textContent =
      '所选区间共 ' + sp.length + ' 个交易日 · 当前利差 ' + cur.toFixed(2) + '% · 区间分位 ' + pct.toFixed(1) + '%';
  }

  /* ---------------- 统一渲染 ---------------- */
  /* ---------------- 海外市场视图 ---------------- */
  function renderMarket(m) {
    var rowsAll = m.rows || [];
    if (!rowsAll.length) return;
    var r = state.ranges[m.code];
    var first = rowsAll[0][0], last = rowsAll[rowsAll.length - 1][0];
    var a = r.from < first ? first : r.from;
    var b = r.to > last ? last : r.to;
    if (a > b) { var tmp = a; a = b; b = tmp; }
    r.from = a;
    r.to = b;

    var title = document.getElementById('nkTitle');
    if (title) title.textContent = m.name + ' · 定投年化';

    var rangeNote = document.getElementById('nkRangeNote');
    if (rangeNote) {
      rangeNote.textContent = '数据范围 ' + first + ' ~ ' + last + ' · ' +
        String(rowsAll.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
        ' 个交易日' + (m.source ? ' · ' + m.source : '');
    }

    var active = document.activeElement;
    if (!active || NK_FIELDS.from.indexOf(active.id) < 0) nkWriteSide('from', a);
    if (!active || NK_FIELDS.to.indexOf(active.id) < 0) nkWriteSide('to', b);

    var rows = rowsAll.filter(function (x) { return x[0] >= a && x[0] <= b; });

    var elIrr = document.getElementById('nkIrr');
    var elIrrSub = document.getElementById('nkIrrSub');
    var elBh = document.getElementById('nkBh');
    var elBhSub = document.getElementById('nkBhSub');
    var elNote = document.getElementById('nkNote');

    if (rows.length < 20) {
      elIrr.textContent = '--'; elBh.textContent = '--';
      elIrrSub.textContent = ''; elBhSub.textContent = '';
      elNote.textContent = '所选区间数据不足。';
      return;
    }

    var px = rows.map(function (x) { return x[1]; });
    var dates = rows.map(function (x) { return x[0]; });
    var t0 = new Date(dates[0] + 'T00:00:00').getTime();
    var tEnd = new Date(dates[dates.length - 1] + 'T00:00:00').getTime();

    // 每个交易日定额定投 1 份
    var units = 0, flows = [], n = 0;
    for (var i = 0; i < px.length; i++) {
      if (!(px[i] > 0)) continue;
      units += 1 / px[i];
      n++;
      flows.push([(new Date(dates[i] + 'T00:00:00').getTime() - t0) / 86400000, -1]);
    }
    var endVal = units * px[px.length - 1];
    flows.push([(tEnd - t0) / 86400000, endVal]);
    var irr = xirr(flows);
    var totalRet = endVal / n - 1;

    var days = Math.max(1, (tEnd - t0) / 86400000);
    var bhAnn = Math.pow(px[px.length - 1] / px[0], 365 / days) - 1;
    var bhTotal = px[px.length - 1] / px[0] - 1;
    var sign = function (v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; };
    // 累计收益超过 10 倍时改用「倍」显示，避免出现 +36971.8% 这种长串
    var signTotal = function (v) {
      if (Math.abs(v) >= 10) return (1 + v).toFixed(1) + ' 倍';
      return sign(v);
    };

    elIrr.textContent = sign(irr);
    elIrr.className = 'nk-val ' + (irr >= 0 ? 'up' : 'down');
    elIrrSub.textContent = '累计 ' + signTotal(totalRet) + ' · 投入 ' + n + ' 次';
    elBh.textContent = sign(bhAnn);
    elBh.className = 'nk-val small ' + (bhAnn >= 0 ? 'up' : 'down');
    elBhSub.textContent = '累计 ' + signTotal(bhTotal);
    elNote.textContent = '所选区间 ' + dates[0] + ' ~ ' + dates[dates.length - 1] + '，共 ' + n +
      ' 个交易日 · 每个交易日定额定投，一直持有不卖出 · 价格口径（不含股息），未计费用。';

    if (!charts.market) charts.market = echarts.init(document.getElementById('nikkeiChart'));
    var data = rows.map(function (x) { return [x[0], x[1]]; });
    var color = m.color || '#334155';
    charts.market.setOption({
      grid: { left: 62, right: 24, top: 26, bottom: 42 },
      tooltip: baseTooltip(function (params) {
        if (!params.length) return '';
        var p = params[0];
        return '<div style="font-weight:600;margin-bottom:4px">' + p.axisValueLabel + '</div>' +
          '<div style="display:flex;justify-content:space-between;gap:18px">' +
          '<span style="color:#cbd5e1">' + p.marker + m.name + '</span>' +
          '<b style="font-variant-numeric:tabular-nums">' + fmt(p.value[1], metricCfg('pe')) + '</b></div>';
      }),
      xAxis: timeAxis(dates),
      yAxis: [{
        type: 'value', scale: true, position: 'left',
        axisLabel: {
          color: AXIS_TEXT, fontSize: 11,
          formatter: function (v) { return v >= 10000 ? (v / 10000).toFixed(1) + '万' : v; }
        },
        splitLine: { lineStyle: { color: SPLIT_LINE } }
      }],
      series: [{
        name: m.name, type: 'line', data: data,
        showSymbol: false, sampling: 'lttb', smooth: false,
        lineStyle: { width: 1.6, color: color },
        areaStyle: { color: hexA(color, .10) }
      }]
    }, true);
    charts.market.resize();
  }

  function renderAll() {
    var mk = marketOf(state.index);
    var isMarket = !!mk;
    document.body.classList.toggle('market-mode', isMarket);
    document.getElementById('nikkeiCard').hidden = !isMarket;

    renderIndexTabs();

    Array.prototype.forEach.call(elIndexTabs.children, function (node) {
      node.classList.toggle('on', node.dataset.code === state.index);
    });
    Array.prototype.forEach.call(elRange.children, function (node) {
      node.classList.toggle('on', String(node.dataset.range) === String(state.range));
    });
    Array.prototype.forEach.call(elMetricTabs.children, function (node) {
      node.classList.toggle('on', node.dataset.metric === state.metric);
    });
    if (elStop) {
      Array.prototype.forEach.call(elStop.children, function (node) {
        node.classList.toggle('on', node.dataset.stop === state.stop);
      });
    }

    if (isMarket) {
      renderMarket(mk);
      try {
        var rr = state.ranges[mk.code];
        history.replaceState(null, '', '#' + mk.code + '/' + rr.from + '/' + rr.to);
      } catch (err) { /* file:// 下忽略 */ }
      return;
    }

    var idx = DATA.indices.filter(function (i) { return i.code === state.index; })[0] || DATA.indices[0];
    var accent = INDEX_COLORS[idx.code] || '#2563eb';
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-soft', hexA(accent, .1));

    var cfg = metricCfg(state.metric);
    var allRows = SERIES[idx.code];
    var rows = windowRows(allRows, state.range);
    var s = stats(rows, cfg.key);

    renderKpis(rows);
    renderAdvice();
    renderMain(rows, cfg, accent);
    renderKline(idx);
    renderSpread(rows, accent);
    renderPct(rows, accent);
    renderDist(rows);

    var rangeLabel = state.range === 'all' ? '全部历史' : '近' + state.range + '年';
    document.getElementById('mainNote').innerHTML =
      idx.name + ' · ' + rangeLabel + ' · 当前 ' +
      (s ? fmt(s.last, cfg) + (cfg.unit || '') : '--') +
      ' · 分位 <b>' + (s ? s.pct.toFixed(1) + '%' : '--') + '</b>';

    try {
      history.replaceState(null, '', '#' + state.index + '/' + state.range + '/' + state.metric + '/' + state.stop);
    } catch (err) { /* file:// 下个别浏览器禁止 replaceState，忽略即可 */ }
  }

  /* ---------------- 页脚 ---------------- */
  document.getElementById('sources').innerHTML = DATA.meta.sources.map(function (s) {
    return '· <a href="' + s.url + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline dotted">' +
      s.name + '</a>（' + s.desc + '）';
  }).join('<br>');
  document.getElementById('footMeta').textContent =
    '数据更新 ' + DATA.meta.generatedAt + ' · 指数估值截至 ' + DATA.meta.latestDate +
    ' · 10年期国债截至 ' + DATA.meta.bondLatest +
    ' · 口径 ' + (DATA.meta.method || '自由流通市值加权') +
    '（成分股名单 ' + (DATA.meta.constituentAsOf || '--') + '）';

  window.addEventListener('resize', function () {
    Object.keys(charts).forEach(function (k) { charts[k].resize(); });
  });

  renderAll();
  setTimeout(function () { Object.keys(charts).forEach(function (k) { charts[k].resize(); }); }, 60);
})();
