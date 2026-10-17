"""下载成分股名单（中证指数官网 OSS 的 cons.xls）。"""
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts", "vendor"))
import xlrd  # noqa: E402  已随仓库提供的纯 Python xls 解析器

OUT = os.path.join(ROOT, "data", "constituents.json")
UA = {"User-Agent": "Mozilla/5.0"}
OSS = "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/%scons.xls"

INDICES = [("000300", "沪深300"), ("000510", "中证A500")]


def fetch(code):
    data = urllib.request.urlopen(
        urllib.request.Request(OSS % code, headers=UA), timeout=120).read()
    sh = xlrd.open_workbook(file_contents=data).sheet_by_index(0)
    rows = []
    for r in range(1, sh.nrows):
        rows.append({
            "code": str(sh.cell_value(r, 4)).strip(),
            "name": sh.cell_value(r, 5),
            "date": str(sh.cell_value(r, 0)),
        })
    return rows


def main():
    out = {"generatedAt": None, "indices": {}}
    import datetime as dt
    out["generatedAt"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    for code, name in INDICES:
        rows = fetch(code)
        out["indices"][code] = {"name": name, "asOf": rows[0]["date"] if rows else None, "members": rows}
        print(code, name, len(rows), "只，日期", rows[0]["date"] if rows else "-")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("写入", OUT)


if __name__ == "__main__":
    main()
