"""下载成分股名单（中证指数官网 OSS 的 cons.xls）。

失败策略：
  1. 每个文件重试 4 次（指数退避）；
  2. 仍失败时，如果仓库里已有 data/constituents.json，就沿用旧名单继续跑
     （成分股按季度调整，隔天用旧名单对估值的影响可以忽略）；
  3. 只有在完全没有旧名单时才报错退出。
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts", "vendor"))
import xlrd  # noqa: E402  已随仓库提供的纯 Python xls 解析器

OUT = os.path.join(ROOT, "data", "constituents.json")
UA = {"User-Agent": "Mozilla/5.0"}
OSS = "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/%scons.xls"

INDICES = [("000300", "沪深300"), ("000510", "中证A500")]


def http_get(url, retries=4, timeout=120):
    last = None
    for i in range(retries):
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, headers=UA), timeout=timeout).read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            wait = 3 + 5 * i
            print("    第 %d 次失败：%s，%d 秒后重试" % (i + 1, exc, wait), flush=True)
            time.sleep(wait)
    raise last


def fetch(code):
    data = http_get(OSS % code)
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

    failed = []
    for code, name in INDICES:
        try:
            rows = fetch(code)
            out["indices"][code] = {"name": name, "asOf": rows[0]["date"] if rows else None, "members": rows}
            print(code, name, len(rows), "只，日期", rows[0]["date"] if rows else "-")
        except Exception as exc:  # noqa: BLE001
            print("!! %s %s 拉取失败：%s" % (code, name, exc))
            failed.append(code)

    if out["indices"]:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print("写入", OUT)
        if failed:
            print("注意：%s 未更新，下游将缺少这些指数的成分股" % ",".join(failed))
        return 0

    # 全部失败：沿用旧名单
    if os.path.exists(OUT):
        old = json.load(open(OUT, encoding="utf-8"))
        print("!! 全部失败，沿用已有名单（%s，生成于 %s），继续后续步骤"
              % (OUT, old.get("generatedAt")))
        return 0

    print("!! 全部失败且没有可用旧名单，中止")
    return 1


if __name__ == "__main__":
    sys.exit(main())
