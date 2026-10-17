"""分批下载成分股的日频估值数据（东方财富数据中心 · 估值分析）。

每个股票一次请求，返回 10 年+ 的日频序列：
  PE_TTM、PB_MRQ、NOTLIMITED_MARKETCAP_A(自由流通市值)、CLOSE_PRICE

结果按股票缓存到 data/raw/stocks/{code}.json，可断点续传。
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data", "raw", "stocks")
CONS = os.path.join(ROOT, "data", "constituents.json")
UA = {"User-Agent": "Mozilla/5.0"}
BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get?"
START = "2016-01-01"
COLS = "TRADE_DATE,PE_TTM,PB_MRQ,NOTLIMITED_MARKETCAP_A,TOTAL_MARKET_CAP,CLOSE_PRICE"


def fetch_one(code, retries=3):
    flt = "(SECURITY_CODE=\"%s\")(TRADE_DATE>='%s')" % (code, START)
    url = (BASE + "reportName=RPT_VALUEANALYSIS_DET&columns=" + COLS +
           "&filter=" + urllib.parse.quote(flt) +
           "&pageNumber=1&pageSize=5000&source=WEB&client=WEB"
           "&sortColumns=TRADE_DATE&sortTypes=-1")
    last = None
    for attempt in range(retries):
        try:
            raw = urllib.request.urlopen(
                urllib.request.Request(url, headers=UA), timeout=90).read()
            j = json.loads(raw)
            rows = (j.get("result") or {}).get("data") or []
            out = []
            for r in rows:
                d = (r.get("TRADE_DATE") or "")[:10]
                if not d:
                    continue
                out.append([d, r.get("PE_TTM"), r.get("PB_MRQ"),
                            r.get("NOTLIMITED_MARKETCAP_A"), r.get("TOTAL_MARKET_CAP"),
                            r.get("CLOSE_PRICE")])
            out.sort(key=lambda x: x[0])
            return code, out
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.0 * (attempt + 1))
    return code, None, repr(last)[:120]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=int(os.environ.get("STOCK_WORKERS", "6")))
    ap.add_argument("--full", action="store_true", help="忽略当日缓存，全部重新抓取")
    args = ap.parse_args()

    cons = json.load(open(CONS, encoding="utf-8"))
    codes = sorted({m["code"] for idx in cons["indices"].values() for m in idx["members"]})
    if args.limit:
        codes = codes[:args.limit]
    os.makedirs(OUT_DIR, exist_ok=True)

    today = dt.date.today()

    def fresh(code):
        path = os.path.join(OUT_DIR, code + ".json")
        if args.full or not os.path.exists(path):
            return False
        return dt.date.fromtimestamp(os.path.getmtime(path)) == today

    todo = [c for c in codes if not fresh(c)]
    todo = [c for c in codes if not fresh(c)]
    print("成分股合计 %d 只，待抓取 %d 只，并发 %d" % (len(codes), len(todo), args.workers))

    ok = fail = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_one, c): c for c in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            res = fut.result()
            code, rows = res[0], res[1]
            if rows is None:
                fail += 1
                print("  ! %s 失败 %s" % (code, res[2] if len(res) > 2 else ""))
            else:
                ok += 1
                with open(os.path.join(OUT_DIR, code + ".json"), "w", encoding="utf-8") as f:
                    json.dump(rows, f, separators=(",", ":"))
            if i % 50 == 0 or i == len(todo):
                print("  进度 %d/%d  成功 %d 失败 %d  用时 %.0fs" %
                      (i, len(todo), ok, fail, time.time() - t0))
    print("完成：成功 %d，失败 %d" % (ok, fail))


if __name__ == "__main__":
    sys.exit(main())
