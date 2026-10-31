#!/usr/bin/env python3
"""Check the analysis output against a fake recording's answer key (truth.json).

  - Depots: each true depot matched to the nearest found one (distance, vehicles).
  - Congestion: for weekday segments, measured slow-down (median / free-flow run
    time) against the true one, 1 / (1 - severity x peak(hour)), at every hour
    with data: correlation and typical error.
  - Bus lanes: the measured peak slow-down of segments with and without a bus
    lane (the analysis is not told which have one).

    python3 analysis/validate.py --fake recordings-fake --profiles analysis/out/fake-profiles.json --depots analysis/out/fake-depots.json
"""
import argparse
import json
import math
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "recorder"))
import gtfs  # noqa: E402
from fake import peak  # noqa: E402


def corr(a, b):
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return num / den if den else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fake", default=str(HERE.parent / "recordings-fake"))
    ap.add_argument("--profiles", default=str(HERE / "out" / "fake-profiles.json"))
    ap.add_argument("--depots", default=str(HERE / "out" / "fake-depots.json"))
    args = ap.parse_args()
    truth = json.loads((Path(args.fake) / "truth.json").read_text(encoding="utf-8"))
    prof = json.loads(Path(args.profiles).read_text(encoding="utf-8"))
    found = json.loads(Path(args.depots).read_text(encoding="utf-8"))

    print("Depots")
    for name, d in truth["depots"].items():
        tx, ty = gtfs.to_xy(d["lat"], d["lon"])
        best = min(found, key=lambda f: math.dist((tx, ty), gtfs.to_xy(f["lat"], f["lon"]))) if found else None
        dist = math.dist((tx, ty), gtfs.to_xy(best["lat"], best["lon"])) if best else float("inf")
        print(f"  {name:22} {'found' if dist < 300 else 'MISSED':6} {dist:6.0f} m  {best['vehicles'] if best else 0} vehicles")
    print(f"  {len(found)} found in total")

    est, true, errs, by_lane = [], [], [], {True: [], False: []}
    for seg, p in prof["segments"].items():
        t = truth["segments"].get(seg)
        if not t or "wd" not in p or p["free"] <= 0:
            continue
        for hour, (median, n) in p["wd"].items():
            if n < 2:
                continue
            e = median / p["free"]
            tr = 1 / (1 - t["severity"] * peak(int(hour) * 3600 + 1800, 0))
            est.append(e)
            true.append(tr)
            errs.append(abs(e - tr) / tr)
            if int(hour) in (8, 17, 18):
                by_lane[t["bus_lane"]].append(e)
    print("\nCongestion (weekday segment-hours with 2+ runs)")
    print(f"  {len(est)} segment-hours, correlation {corr(est, true):.2f}, median error {statistics.median(errs) * 100:.1f}%")
    # Individual segment-hours are noisy with few runs; grouped by true slow-down the
    # medians show whether the method is biased.
    for lo, hi in [(1.0, 1.1), (1.1, 1.25), (1.25, 1.5), (1.5, 2.0), (2.0, 9.0)]:
        sel = [e for e, tr in zip(est, true) if lo <= tr < hi]
        if sel:
            print(f"  true x{lo:.2f}-{hi:.2f}: measured median x{statistics.median(sel):.2f} ({len(sel)} segment-hours)")
    for lane in (True, False):
        v = by_lane[lane]
        if v:
            print(f"  peak slow-down {'with' if lane else 'without'} bus lane: median x{statistics.median(v):.2f} ({len(v)} segment-hours)")


if __name__ == "__main__":
    main()
