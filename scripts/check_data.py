import datetime as dt
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "web", "data", "app-data.js")

MAX_STALE_DAYS = 10


def fail(errors):
    print("数据健康检查未通过：")
    for e in errors:
        print("  ✗", e)
    return 1


def main():
    if not os.path.exists(PATH):
        return fail(["找不到 %s" % PATH])
    text = open(PATH, encoding="utf-8").read()
    m = re.match(r"\s*window\.__VALUATION_DATA__\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
    if not m:
        return fail(["app-data.js 格式异常（不是 window.__VALUATION_DATA__ = {...};）"])
    try:
        payload = json.loads(m.group(1))
    except Exception as exc:  # noqa: BLE001
        return fail(["app-data.js JSON 解析失败：%s" % exc])

    errors = []
    today = dt.date.today()
    meta = payload.get("meta") or {}
    indices = payload.get("indices") or []
    bonds = payload.get("bonds") or []

    if len(indices) != 2:
        errors.append("指数数量应为 2，实际 %d" % len(indices))
    if len(bonds) < 5000:
        errors.append("国债收益率记录过少：%d" % len(bonds))

    latest_dates = set()
    for idx in indices:
        name = idx.get("name", "?")
        rows = idx.get("rows") or []
        if len(rows) < 2000:
            errors.append("%s 交易日过少：%d" % (name, len(rows)))
            continue
        d, close, pe, pb, dy = rows[-1][:5]
        latest_dates.add(d)
        if not (5 <= pe <= 60):
            errors.append("%s 最新 PE %.2f 超出合理区间 [5, 60]" % (name, pe))
        if not (0.3 <= pb <= 12):
            errors.append("%s 最新 PB %.2f 超出合理区间 [0.3, 12]" % (name, pb))
        if not (0.2 <= dy <= 10):
            errors.append("%s 最新股息率 %.2f%% 超出合理区间 [0.2, 10]" % (name, dy))
        if not (500 <= close <= 20000):
            errors.append("%s 最新点位 %.2f 异常" % (name, close))
        if not idx.get("ohlc"):
            errors.append("%s 缺少日 K 数据" % name)

    if len(latest_dates) > 1:
        errors.append("两个指数最新日期不一致：%s" % sorted(latest_dates))

    latest = None
    if latest_dates:
        latest = min(latest_dates)
        try:
            d = dt.date.fromisoformat(latest)
            if (today - d).days > MAX_STALE_DAYS:
                errors.append("最新数据日期 %s 距今 %d 天，超过 %d 天"
                              % (latest, (today - d).days, MAX_STALE_DAYS))
        except ValueError:
            errors.append("最新数据日期格式异常：%s" % latest)

    if meta.get("latestDate") != latest:
        errors.append("meta.latestDate=%s 与数据最新日期 %s 不一致" % (meta.get("latestDate"), latest))

    if bonds:
        try:
            bd = dt.date.fromisoformat(bonds[-1][0])
            if (today - bd).days > 20:
                errors.append("国债收益率最新日期 %s 距今过久" % bonds[-1][0])
        except ValueError:
            errors.append("国债收益率日期格式异常：%s" % bonds[-1][0])

    if errors:
        return fail(errors)

    print("数据健康检查通过：最新 %s，指数 %d 个，交易日 %s，国债 %d 条"
          % (latest, len(indices), [len(i["rows"]) for i in indices], len(bonds)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
