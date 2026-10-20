"""检查 app-data.js 的最新日期是否已经覆盖「最近一个交易日」。

用途：晚上 18:30 跑更新时，数据源（东财个股估值）可能还没发布当天数据。
        这个脚本用来判断要不要再等一会儿重试。

退出码：
  0 = 已经覆盖最近交易日，可以发布
  1 = 还没更新到最近交易日（数据源滞后），建议等 20 分钟后重试
"""
import datetime as dt
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "web", "data", "app-data.js")


def latest_date():
    text = open(PATH, encoding="utf-8").read()
    m = re.match(r"\s*window\.__VALUATION_DATA__\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
    payload = json.loads(m.group(1))
    return payload["meta"]["latestDate"]


def expected_trading_day(now_utc):
    """最近一个应该已经有数据的交易日（按北京时间判断）。

    16:00 之前跑，当天还没收盘或数据未出，期望值取前一个工作日；
    周末回退到周五。法定节假日无法判断，靠调用方容忍失败。
    """
    bj = now_utc + dt.timedelta(hours=8)
    d = bj.date()
    if bj.hour < 16:
        d -= dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


def main():
    if not os.path.exists(PATH):
        print("找不到 %s" % PATH)
        return 1
    latest = latest_date()
    expect = expected_trading_day(dt.datetime.now(dt.timezone.utc))
    if latest >= expect:
        print("数据已覆盖最近交易日：latest=%s  expect=%s" % (latest, expect))
        return 0
    print("数据尚未覆盖最近交易日：latest=%s  expect=%s" % (latest, expect))
    return 1


if __name__ == "__main__":
    sys.exit(main())
