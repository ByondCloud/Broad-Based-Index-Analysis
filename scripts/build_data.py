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


def http_get(url, retries=4, timeout=90):
    """带重试的 GET，返回原始 bytes。"""
    last = None
    for i in range(retries):
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, headers=UA), timeout=timeout).read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            wait = 3 + 5 * i
            print("    请求失败（第 %d 次）：%s，%d 秒后重试" % (i + 1, exc, wait), flush=True)
            time.sleep(wait)
    raise last


def fetch_fred(series):
    """FRED 日频序列 → [[date, close], ...]"""
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + series
    raw = http_get(url).decode("utf-8", "replace")
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
    raw = http_get(url).decode("utf-8", "replace")
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


def fetch_markets():
    """海外市场：日经225（FRED 1949 起）+ 标普500（Yahoo 1970 起，失败回退 FRED 近10年）。"""
    markets = []
    nikkei = fetch_fred("NIKKEI225")
    markets.append({"code": "N225", "name": "日经225", "color": "#c0392b",
                    "source": "FRED · NIKKEI225", "rows": nikkei})
    print("    日经225 %d 个交易日，%s → %s" % (len(nikkei), nikkei[0][0], nikkei[-1][0]))

    try:
        spx = fetch_yahoo("%5EGSPC")
        source = "Yahoo Finance · ^GSPC"
    except Exception as exc:  # noqa: BLE001
        print("    Yahoo 失败（%s），回退 FRED SP500（仅近 10 年）" % exc)
        spx = fetch_fred("SP500")
        source = "FRED · SP500"
    markets.append({"code": "SPX", "name": "标普500", "color": "#1d4ed8",
                    "source": source, "rows": spx})
    print("    标普500 %d 个交易日，%s → %s（%s）" % (len(spx), spx[0][0], spx[-1][0], source))
    return markets


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
    rows = {}
    page = 1
    while True:
        payload = json.loads(http_get(TREASURY_URL.format(page=page)))
        result = payload.get("result") or {}
        data = result.get("data") or []
        if not data:
            break
        for r in data:
            d = (r.get("SOLAR_DATE") or "")[:10]
            v = r.get(TREASURY_FIELD)
            if d and v is not None:
                rows[d] = round(float(v), 4)
        if page >= (result.get("pages") or 1):
            break
        page += 1
    return [[d, rows[d]] for d in sorted(rows)]


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

    print("拉取指数点位（日 K）...")
    ohlc = {i["code"]: fetch_index_ohlc(i["code"]) for i in INDICES}
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

    print("拉取 10 年期国债收益率 ...")
    bonds = fetch_treasury()
    print("    %d 条，%s → %s" % (len(bonds), bonds[0][0], bonds[-1][0]))

    print("拉取海外市场点位 ...")
    markets = fetch_markets()

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
