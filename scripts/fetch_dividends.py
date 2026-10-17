"""下载全市场分红送配数据（东方财富），用于计算个股股息率（TTM）。

保存字段：[除权除息日, 预案公告日, 财报期, 每股税前派息, 送股比例, 转增比例]
"""
import json
import os
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "raw", "dividends.json")
UA = {"User-Agent": "Mozilla/5.0"}
BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get?"
COLS = "SECURITY_CODE,EX_DIVIDEND_DATE,PLAN_NOTICE_DATE,REPORT_DATE,PRETAX_BONUS_RMB,BONUS_RATIO,IT_RATIO"


def get(url, retries=4):
    last = None
    for i in range(retries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90).read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 + 2 * i)
    raise last


def main():
    rows = []
    page = 1
    while True:
        flt = "(EX_DIVIDEND_DATE>='2015-01-01')"
        url = (BASE + "reportName=RPT_SHAREBONUS_DET&columns=" + COLS +
               "&filter=" + urllib.parse.quote(flt) +
               "&pageNumber=%d&pageSize=500&source=WEB&client=WEB" % page)
        result = (json.loads(get(url)).get("result") or {})
        data = result.get("data") or []
        if not data:
            break
        for r in data:
            d = (r.get("EX_DIVIDEND_DATE") or "")[:10]
            if not d or r.get("PRETAX_BONUS_RMB") is None:
                continue
            rows.append([r["SECURITY_CODE"], d,
                         (r.get("PLAN_NOTICE_DATE") or "")[:10],
                         (r.get("REPORT_DATE") or "")[:10],
                         round(float(r["PRETAX_BONUS_RMB"]) / 10.0, 6),
                         round(float(r.get("BONUS_RATIO") or 0) / 10.0, 6),
                         round(float(r.get("IT_RATIO") or 0) / 10.0, 6)])
        pages = result.get("pages") or 1
        print("  分红 第 %d/%d 页，累计 %d 条" % (page, pages, len(rows)), flush=True)
        if page >= pages:
            break
        page += 1
        time.sleep(0.15)

    grouped = {}
    for code, ex, notice, report, dps, bonus, transfer in rows:
        grouped.setdefault(code, []).append([ex, notice, report, dps, bonus, transfer])
    for code in grouped:
        grouped[code].sort(key=lambda x: x[0])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(grouped, f, ensure_ascii=False, separators=(",", ":"))
    print("写入 %s：%d 只股票，%d 条分红记录" % (OUT, len(grouped), len(rows)))


if __name__ == "__main__":
    main()
