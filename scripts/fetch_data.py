"""一键更新看板数据。

流程：
  1. fetch_constituents.py  中证指数官网 → 最新成分股名单
  2. fetch_stocks.py        东方财富 → 每只成分股的日频 PE/PB/自由流通市值/收盘价
  3. fetch_dividends.py     东方财富 → 全市场分红送配（用于个股股息率）
  4. build_data.py          按自由流通市值加权聚合并生成 web/data/app-data.js

只用 Python 标准库（xls 解析用仓库内的 scripts/vendor/xlrd）。

注意：第 2 步固定加 --full。个股数据有「当天已抓过就跳过」的缓存，
如果上午跑过一次、晚上再跑，缓存会让晚上的更新沿用盘前数据（缺少当日行情）。
全量重抓约 40 秒，不值得为省这点时间去冒数据不更新的风险。
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STEPS = [
    ("fetch_constituents.py", []),
    ("fetch_stocks.py", ["--full"]),
    ("fetch_dividends.py", []),
    ("build_data.py", []),
]


def main():
    for i, (step, extra) in enumerate(STEPS, 1):
        print("\n[%d/%d] %s %s" % (i, len(STEPS), step, " ".join(extra)), flush=True)
        code = subprocess.call([sys.executable, os.path.join(HERE, step)] + extra)
        if code != 0:
            print("步骤 %s 失败（exit %d），已中止" % (step, code), flush=True)
            return code
    print("\n全部完成，刷新页面即可看到最新数据。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
