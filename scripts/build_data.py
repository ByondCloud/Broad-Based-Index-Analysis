"""按自由流通市值加权合成指数估值序列，并生成前端数据文件。

聚合口径（对每个交易日 t）：
    w_i(t) = 自由流通市值_i(t) / Σ 自由流通市值_j(t)
    PE(t)  = Σ 自由流通市值_i(t) / Σ 净利润_i(t)        # 亏损股的负净利润计入分母
    PB(t)  = Σ 自由流通市值_i(t) / Σ 净资产_i(t)
    股息率(t) = Σ [ w_i(t) × 个股股息率_i(t) ]

个股股息率采用“预案口径”：分红方案一经公告即计入（除按 12 个月滚动外，
同一财报期只保留最新一期，避免中期分红跨年重复计算），与理杏仁的预期股息率思路一致。
"""
import bisect
import datetime as dt
import json
import os
import re
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
STOCK_DIR = os.path.join(RAW, "stocks")
OUT = os.path.join(ROOT, "web", "data", "app-data.js")
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.csindex.com.cn/"}

INDICES = [
    {"code": "000510", "name": "中证A500", "label": "CSI A500", "short": "A500"},
    {"code": "000300", "name": "沪深300", "label": "CSI 300", "short": "HS300"},
]
TREASURY_URL = (
    "https://datacenter-web.eastmoney.com/api/data/v1/get?"
    "reportName=RPTA_WEB_TREASURYYIELD&columns=ALL&sortColumns=SOLAR_DATE&sortTypes=-1"
    "&pageNumber={page}&pageSize=5000&source=WEB&client=WEB"
)
TREASURY_FIELD = "EMM00166466"  # 中国国债收益率 10 年
US_TREASURY_FIELD = "EMG00001310"  # 美国国债收益率 10 年（同一张表）


def http_get(url, retries=4, timeout=90, headers=None):
    """带重试的 GET，返回原始 bytes。"""
    last = None
    for i in range(retries):
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, headers=headers or UA), timeout=timeout).read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            wait = 3 + 5 * i
            print("    请求失败（第 %d 次）：%s，%d 秒后重试" % (i + 1, exc, wait), flush=True)
            time.sleep(wait)
    raise last


def fetch_fred(series):
    """FRED 日频序列 → [[date, close], ...]（有兜底，重试 2 次即可）"""
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + series
    raw = http_get(url, retries=2).decode("utf-8", "replace")
    out = []
    for i, line in enumerate(raw.splitlines()):
        if i == 0 or not line.strip():
            continue
        parts = line.split(",")
        if len(parts) < 2 or parts[1] in (".", ""):
            continue
        try:
            out.append([parts[0].strip(), round(float(parts[1]), 2)])
        except ValueError:
            continue
    return out


def fetch_yahoo(symbol):
    """Yahoo Finance 全历史日线 → [[date, close], ...]"""
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/%s"
           "?period1=0&period2=9999999999&interval=1d" % symbol)
    raw = http_get(url, retries=2).decode("utf-8", "replace")
    result = (json.loads(raw).get("chart") or {}).get("result") or []
    if not result:
        raise RuntimeError("Yahoo 返回空数据：%s" % symbol)
    res = result[0]
    ts = res.get("timestamp") or []
    closes = ((res.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    out = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        d = dt.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d")
        out.append([d, round(float(c), 2)])
    out.sort(key=lambda x: x[0])
    return out


def load_previous():
    """读上一次生成的 app-data.js，作为网络失败时的兜底数据。"""
    if not os.path.exists(OUT):
        return {}
    try:
        text = open(OUT, encoding="utf-8").read()
        m = re.search(r"window\.__VALUATION_DATA__\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
        return json.loads(m.group(1)) if m else {}
    except Exception:  # noqa: BLE001
        return {}


def fetch_us10():
    """美国 10 年期国债收益率（FRED DGS10），只保留 2017 年以后。"""
    data = fetch_fred("DGS10")
    return [r for r in data if r[0] >= "2017-01-01"]


def _one_market(code, name, color, em_secid, fallbacks, prev_map):
    """按顺序尝试各个数据源，全部失败时沿用上次数据。"""
    chain = []
    if em_secid:
        chain.append(("Eastmoney", lambda: fetch_em_kline(em_secid)))
    chain.extend(fallbacks)
    for label, fn in chain:
        try:
            rows = fn()
            if len(rows) < 1000:
                raise RuntimeError("%s 返回数据过少（%d 条）" % (label, len(rows)))
            print("    %s %d 个交易日，%s → %s（%s）"
                  % (name, len(rows), rows[0][0], rows[-1][0], label))
            return {"code": code, "name": name, "color": color,
                    "source": label, "rows": rows}
        except Exception as exc:  # noqa: BLE001
            print("    %s 用 %s 失败：%s" % (name, label, exc))
    if code in prev_map:
        print("    !! %s 全部来源失败，沿用上次数据（截至 %s）"
              % (name, prev_map[code]["rows"][-1][0]))
        return prev_map[code]
    raise RuntimeError("%s 所有来源都失败" % name)


def fetch_markets(prev):
    """海外市场：Yahoo（最快最稳）→ FRED → 沿用上次数据。

    注：东财 push2his 的海外指数接口在本机长期连接被重置，已不采用。
    """
    prev_map = {m["code"]: m for m in (prev.get("markets") or [])}
    return [
        _one_market("N225", "日经225", "#c0392b", None,
                    [("Yahoo", lambda: fetch_yahoo("%5EN225")),
                     ("FRED", lambda: fetch_fred("NIKKEI225"))], prev_map),
        _one_market("SPX", "标普500", "#1d4ed8", None,
                    [("Yahoo", lambda: fetch_yahoo("%5EGSPC")),
                     ("FRED", lambda: fetch_fred("SP500"))], prev_map),
    ]


def fetch_index_ohlc(code):
    """日 K 线：[日期, 开, 高, 低, 收, 成交额(亿元)]"""
    url = ("https://www.csindex.com.cn/csindex-home/perf/index-perf"
           "?indexCode=%s&startDate=20160101&endDate=20991231" % code)
    data = json.loads(http_get(url))["data"]
    out = {}
    for r in data or []:
        d = r.get("tradeDate") or ""
        if len(d) != 8:
            continue
        vals = [r.get("open"), r.get("high"), r.get("low"), r.get("close")]
        if any(v is None for v in vals):
            continue
        out["%s-%s-%s" % (d[:4], d[4:6], d[6:])] = [
            round(float(vals[0]), 2), round(float(vals[1]), 2),
            round(float(vals[2]), 2), round(float(vals[3]), 2),
            round(float(r.get("tradingValue") or 0), 2)]
    return out


def fetch_treasury():
    """一次请求同时拿中国和美国 10 年期国债收益率（东财「中美国债收益率」表）。

    中国 10Y = EMM00166466，美国 10Y = EMG00001310。
    美债通常比中债晚一天发布，缺失的日期直接跳过，前端按「最近一个已知值」取值。
    """
    cn, us = {}, {}
    page = 1
    while True:
        payload = json.loads(http_get(TREASURY_URL.format(page=page)))
        result = payload.get("result") or {}
        data = result.get("data") or []
        if not data:
            break
        for r in data:
            d = (r.get("SOLAR_DATE") or "")[:10]
            if not d:
                continue
            v = r.get(TREASURY_FIELD)
            if v is not None:
                cn[d] = round(float(v), 4)
            u = r.get(US_TREASURY_FIELD)
            if u is not None:
                us[d] = round(float(u), 4)
        if page >= (result.get("pages") or 1):
            break
        page += 1
    return [[d, cn[d]] for d in sorted(cn)], [[d, us[d]] for d in sorted(us)]


def fetch_em_kline(secid, retries=2):
    """东财行情接口取海外指数日线（国内可访问，比 FRED/Yahoo 稳）。

    返回 [[date, close], ...]
    """
    url = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=%s"
           "&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56"
           "&klt=101&fqt=1&beg=0&end=20500101&lmt=100000" % secid)
    payload = json.loads(http_get(url, retries=retries,
                                  headers={"User-Agent": "Mozilla/5.0",
                                           "Referer": "https://quote.eastmoney.com/"}))
    data = payload.get("data") or {}
    out = []
    for line in data.get("klines") or []:
        p = line.split(",")
        if len(p) < 3:
            continue
        try:
            out.append([p[0], round(float(p[2]), 2)])   # 日期, 收盘
        except ValueError:
            continue
    if not out:
        raise RuntimeError("东财行情返回空数据：%s" % secid)
    return out


class DividendBook:
    """个股分红序列（预案口径 + 同期去重 + 送转调整）。"""

    __slots__ = ("ev", "dates", "fac")

    def __init__(self, events):
        self.ev = events
        self.dates = [e[0] for e in events]
        fac, f = [], 1.0
        for e in events:
            f *= 1.0 + e[4] + e[5]
            fac.append(f)
        self.fac = fac

    def dps_ttm(self, day):
        ev, dates = self.ev, self.dates
        if not ev:
            return 0.0
        cut = (dt.date.fromisoformat(day) - dt.timedelta(days=365)).isoformat()
        lo = bisect.bisect_left(dates, (dt.date.fromisoformat(cut) - dt.timedelta(days=400)).isoformat())
        # 上限要包含「已公告但尚未除权」的分红，因此向后多看 400 天
        hi = bisect.bisect_right(dates, (dt.date.fromisoformat(day) + dt.timedelta(days=400)).isoformat())
        if hi <= lo:
            return 0.0
        best = {}
        cand = []
        for i in range(lo, hi):
            ex, notice, report, dps, _b, _t = ev[i]
            if notice and notice > day:
                continue
            if not (cut <= ex <= day or (notice and cut <= notice <= day)):
                continue
            period = report or ex
            key = period[5:]  # 只看月-日：区分中期 / 年度
            cand.append((i, key, period))
            if key not in best or period > best[key]:
                best[key] = period
        if not cand:
            return 0.0
        j = bisect.bisect_right(dates, day) - 1
        f_now = self.fac[j] if j >= 0 else 1.0
        return sum(ev[i][3] * self.fac[i] / f_now for i, key, period in cand if period == best[key])

def build_index(idx, members, closes, dividends):
    acc = {}  # date -> [自由流通市值, cap/pe, cap/pb, cap*dy]
    used = 0
    for code in members:
        path = os.path.join(STOCK_DIR, code + ".json")
        if not os.path.exists(path):
            continue
        rows = json.load(open(path, encoding="utf-8"))
        if not rows:
            continue
        used += 1
        book = DividendBook(dividends.get(code, []))
        for r in rows:
            d, pe, pb, fcap, _tcap, price = r
            if not price or not fcap or fcap <= 0:
                continue
            a = acc.setdefault(d, [0.0, 0.0, 0.0, 0.0])
            a[0] += fcap
            if pe and abs(pe) > 0.5:
                a[1] += fcap / pe
            if pb and pb > 0:
                a[2] += fcap / pb
            dps = book.dps_ttm(d)
            if dps > 0:
                a[3] += fcap * (dps / price)

    out = []
    for d in sorted(acc):
        s, se, sb, sd = acc[d]
        if s <= 0 or se == 0 or sb == 0:
            continue
        pe = s / se
        if pe <= 0:
            continue
        out.append([d, closes.get(d), round(pe, 4), round(s / sb, 4), round(sd / s * 100.0, 4)])
    print("    %s 成分股 %d 只，%d 个交易日，最新 PE %.2f / PB %.2f / DY %.2f%%"
          % (idx["name"], used, len(out), out[-1][2], out[-1][3], out[-1][4]))
    return out


def main():
    cons = json.load(open(os.path.join(ROOT, "data", "constituents.json"), encoding="utf-8"))
    dividends = json.load(open(os.path.join(RAW, "dividends.json"), encoding="utf-8"))
    print("分红数据：%d 只股票" % len(dividends))

    prev = load_previous()

    print("拉取指数点位（日 K）...")
    ohlc = {}
    prev_ohlc = {i["code"].split(".")[0]: i.get("ohlc") or [] for i in (prev.get("indices") or [])}
    for i in INDICES:
        try:
            ohlc[i["code"]] = fetch_index_ohlc(i["code"])
        except Exception as exc:  # noqa: BLE001
            old = prev_ohlc.get(i["code"])
            if not old:
                raise
            ohlc[i["code"]] = {row[0]: row[1:] for row in old}
            print("    !! %s 日 K 拉取失败（%s），沿用上次数据（%d 根）" % (i["name"], exc, len(old)))
    closes = {c: {d: v[3] for d, v in ohlc[c].items()} for c in ohlc}
    print("    沪深300 %d 根，中证A500 %d 根" % (len(ohlc["000300"]), len(ohlc["000510"])))

    print("聚合指数估值 ...")
    indices = []
    for idx in INDICES:
        members = [m["code"] for m in cons["indices"][idx["code"]]["members"]]
        rows = build_index(idx, members, closes[idx["code"]], dividends)
        k = ohlc[idx["code"]]
        days = [d for d in sorted(k) if d >= rows[0][0]]
        indices.append({"code": idx["code"] + ".SH", "name": idx["name"], "label": idx["label"],
                        "rows": rows,
                        "ohlc": [[d] + k[d] for d in days]})

    print("拉取 10 年期国债收益率（中国 + 美国）...")
    us10_em = []
    try:
        bonds, us10_em = fetch_treasury()
        print("    中国 %d 条，%s → %s" % (len(bonds), bonds[0][0], bonds[-1][0]))
        if us10_em:
            print("    美国 %d 条，%s → %s" % (len(us10_em), us10_em[0][0], us10_em[-1][0]))
    except Exception as exc:  # noqa: BLE001
        if not prev.get("bonds"):
            raise
        bonds = prev["bonds"]
        us10_em = prev.get("us10") or []
        print("    !! 国债收益率拉取失败（%s），沿用上次数据（截至 %s）" % (exc, bonds[-1][0]))

    print("拉取海外市场点位 ...")
    markets = fetch_markets(prev)

    us10 = [r for r in us10_em if r[0] >= "2017-01-01"]
    if not us10:
        print("美债收益率（东财）缺失，回退 FRED ...")
        try:
            us10 = fetch_us10()
            print("    %d 条，%s → %s" % (len(us10), us10[0][0], us10[-1][0]))
        except Exception as exc:  # noqa: BLE001
            if not prev.get("us10"):
                raise
            us10 = prev["us10"]
            print("    !! 美债收益率拉取失败（%s），沿用上次数据（截至 %s）" % (exc, us10[-1][0]))
    else:
        print("美债 10 年期：%d 条（东财），%s → %s" % (len(us10), us10[0][0], us10[-1][0]))

    latest = max(r[-1][0] for r in (i["rows"] for i in indices))
    payload = {
        "meta": {
            "generatedAt": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
            "latestDate": latest,
            "bondLatest": bonds[-1][0] if bonds else None,
            "constituentAsOf": cons["indices"]["000300"]["asOf"],
            "sources": [
                {"name": "中证指数官网", "desc": "成分股名单、指数收盘点位",
                 "url": "https://www.csindex.com.cn"},
                {"name": "东方财富·估值分析", "desc": "个股 PE(TTM)、PB、总市值、自由流通市值、收盘价",
                 "url": "https://data.eastmoney.com/gzfx/"},
                {"name": "东方财富·分红送配 / 中美国债收益率", "desc": "个股分红、10 年期国债收益率",
                 "url": "https://data.eastmoney.com/cjsj/zmgzsyl.html"},
            ],
        },
        "indices": indices,
        "bonds": bonds,
        "us10": us10,
        "markets": markets,
    }
    body = ("window.__VALUATION_DATA__ = "
            + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body)
    print("写入 %s (%.0f KB)" % (OUT, len(body) / 1024))


if __name__ == "__main__":
    main()
