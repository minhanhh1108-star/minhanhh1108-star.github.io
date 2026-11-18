#!/usr/bin/env python3
"""Meta Ads ops CLI: report, audit, copy/create (always PAUSED), status and budget changes.

The access token is NOT read here: the session's network proxy injects it into
requests to graph.facebook.com. Never put a token in this repo.

Usage (run from repo root):
  python3 ads-ops/meta.py accounts
  python3 ads-ops/meta.py report  --account act_X [--preset last_7d] [--level campaign|adset|ad]
  python3 ads-ops/meta.py audit   --account act_X [--preset last_7d]
  python3 ads-ops/meta.py inspect --id <campaign|adset|ad id>
  python3 ads-ops/meta.py copy    --id <campaign|adset id> [--name NEW] [--daily-budget N]
  python3 ads-ops/meta.py create  --spec ads-ops/specs/x.json [--dry-run]
  python3 ads-ops/meta.py upload-image --account act_X --file path.jpg
  python3 ads-ops/meta.py set-status --id ID --status ACTIVE|PAUSED [--confirm]
  python3 ads-ops/meta.py set-budget --id ID --daily-budget N [--confirm] [--force]
"""
import argparse
import datetime as dt
import json
import os
import sys

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8"))
BASE = f"https://graph.facebook.com/{CFG['api_version']}"
LOG_DIR = os.path.join(HERE, "logs")


# ---------- API helpers ----------
def api(method, path, **params):
    url = path if path.startswith("http") else f"{BASE}/{path.lstrip('/')}"
    for k, v in list(params.items()):
        if isinstance(v, (dict, list)):
            params[k] = json.dumps(v, ensure_ascii=False)
    if method == "GET":
        r = requests.get(url, params=params, timeout=60)
    else:
        r = requests.request(method, url, data=params, timeout=120)
    data = r.json()
    if "error" in data:
        e = data["error"]
        sys.exit(f"API error {e.get('code')}/{e.get('error_subcode')}: {e.get('error_user_msg') or e.get('message')}")
    return data


def get_all(path, **params):
    out, data = [], api("GET", path, **params)
    while True:
        out += data.get("data", [])
        nxt = data.get("paging", {}).get("next")
        if not nxt:
            return out
        data = requests.get(nxt, timeout=60).json()


def log(action, payload):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "changes.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": dt.datetime.now().isoformat(timespec="seconds"),
                            "action": action, **payload}, ensure_ascii=False) + "\n")


def money(v):
    return f"{float(v):,.0f}" if v not in (None, "") else "-"


def results_of(row):
    """Return (results, action_type) for the configured primary KPI."""
    acts = {a["action_type"]: float(a["value"]) for a in row.get("actions", [])}
    for t in [CFG["kpi"]["primary_action"]] + CFG["kpi"]["fallback_actions"]:
        if acts.get(t):
            return acts[t], t
    return 0.0, CFG["kpi"]["primary_action"]


# ---------- read ----------
def cmd_accounts(a):
    for acc in get_all("me/adaccounts", fields="id,name,account_status,currency,amount_spent,spend_cap", limit=100):
        cap = "KHÔNG GIỚI HẠN" if acc.get("spend_cap") in ("0", None) else money(acc["spend_cap"])
        print(f"{acc['id']:<22} status={acc['account_status']}  spent={money(acc['amount_spent'])}  cap={cap}  {acc['name']}")


def insights(account, preset, level):
    fields = ("campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,spend,impressions,reach,"
              "frequency,clicks,ctr,cpc,actions")
    return get_all(f"{account}/insights", level=level, date_preset=preset, fields=fields, limit=200)


def rows_with_metrics(account, preset, level):
    rows = []
    for r in insights(account, preset, level):
        res, atype = results_of(r)
        spend = float(r.get("spend", 0))
        rows.append({
            "id": r.get(f"{level}_id"), "name": r.get(f"{level}_name"),
            "spend": spend, "results": res, "action": atype,
            "cpa": spend / res if res else None,
            "ctr": float(r.get("ctr", 0)), "cpc": float(r.get("cpc", 0) or 0),
            "freq": float(r.get("frequency", 0) or 0), "impr": int(r.get("impressions", 0)),
        })
    return sorted(rows, key=lambda x: -x["spend"])


def cmd_report(a):
    rows = rows_with_metrics(a.account, a.preset, a.level)
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1)); return
    tot_s = sum(r["spend"] for r in rows); tot_r = sum(r["results"] for r in rows)
    print(f"# {a.account} | {a.preset} | level={a.level} | KPI={CFG['kpi']['primary_action']} | target CPA={money(CFG['kpi']['target_cpa'])}")
    print(f"TỔNG: spend={money(tot_s)}  results={tot_r:.0f}  CPA={money(tot_s/tot_r) if tot_r else '-'}\n")
    print(f"{'spend':>12} {'res':>5} {'CPA':>10} {'CTR%':>5} {'CPC':>8} {'freq':>4}  name [id]")
    for r in rows:
        print(f"{money(r['spend']):>12} {r['results']:>5.0f} {money(r['cpa']):>10} {r['ctr']:>5.2f} "
              f"{money(r['cpc']):>8} {r['freq']:>4.1f}  {r['name']} [{r['id']}]")


def cmd_audit(a):
    k, rl = CFG["kpi"], CFG["rules"]
    t = k["target_cpa"]
    rows = rows_with_metrics(a.account, a.preset, "adset")
    kill, scale, watch = [], [], []
    for r in rows:
        if r["results"] == 0 and r["spend"] >= rl["kill_if_spend_x_target_no_result"] * t:
            kill.append((r, f"tiêu {money(r['spend'])} không ra kết quả"))
        elif r["cpa"] and r["cpa"] > rl["kill_if_cpa_over_target_x"] * t and r["spend"] >= rl["kill_min_spend_x_target"] * t:
            kill.append((r, f"CPA {money(r['cpa'])} > {rl['kill_if_cpa_over_target_x']}x target"))
        elif r["cpa"] and r["cpa"] < rl["scale_if_cpa_under_target_x"] * t and r["results"] >= rl["scale_min_results"]:
            scale.append((r, f"CPA {money(r['cpa'])}, {r['results']:.0f} kết quả → tăng {rl['scale_step_pct']}%"))
        if r["freq"] > k["max_frequency_7d"]:
            watch.append((r, f"frequency {r['freq']:.1f} → creative fatigue"))
        if r["impr"] > 2000 and r["ctr"] < k["min_ctr_pct"]:
            watch.append((r, f"CTR {r['ctr']:.2f}% thấp → thay hook/creative"))
    for title, items in (("ĐỀ XUẤT TẮT", kill), ("ĐỀ XUẤT SCALE", scale), ("CẦN THEO DÕI", watch)):
        print(f"\n## {title} ({len(items)})")
        for r, why in items:
            print(f"- {r['name']} [{r['id']}]: {why}")


def cmd_inspect(a):
    print(json.dumps(api("GET", a.id, fields=a.fields), ensure_ascii=False, indent=1))


# ---------- write (guarded) ----------
def cmd_copy(a):
    obj = api("GET", a.id, fields="id,name,daily_budget")
    params = {"status_option": "PAUSED", "deep_copy": "true"}
    if a.name:
        params["rename_options"] = {"rename_strategy": "NO_RENAME"}
    res = api("POST", f"{a.id}/copies", **params)
    new_id = res.get("copied_campaign_id") or res.get("copied_adset_id")
    upd = {}
    if a.name:
        upd["name"] = a.name
    if a.daily_budget:
        check_new_budget(a.daily_budget)
        upd["daily_budget"] = int(a.daily_budget)
    if upd and new_id:
        try:
            api("POST", new_id, **upd)
        except SystemExit as e:  # CBO campaigns hold budget on campaign, not ad set
            print(f"Cảnh báo khi cập nhật bản copy: {e}")
    log("copy", {"source": a.id, "new_id": new_id, "update": upd})
    print(f"Đã copy {obj['name']} → {new_id} (PAUSED). Chi tiết: {json.dumps(res)}")


def check_new_budget(v):
    cap = CFG["guardrails"]["max_new_daily_budget"]
    if int(v) > cap:
        sys.exit(f"Chặn: budget {money(v)}/ngày > giới hạn {money(cap)} trong config.json. Sửa config nếu chủ động muốn.")


def cmd_create(a):
    spec = json.load(open(a.spec, encoding="utf-8"))
    acc = spec["account"]
    c, s, ad = spec["campaign"], spec["adset"], spec.get("ad")
    if s.get("daily_budget"):
        check_new_budget(s["daily_budget"])
    if c.get("daily_budget"):
        check_new_budget(c["daily_budget"])
    for o in (c, s):
        o["status"] = "PAUSED"
    if a.dry_run:
        print("DRY RUN, sẽ tạo:\n" + json.dumps(spec, ensure_ascii=False, indent=1)); return
    c.setdefault("special_ad_categories", [])
    camp = api("POST", f"{acc}/campaigns", **c)["id"]
    s["campaign_id"] = camp
    adset = api("POST", f"{acc}/adsets", **s)["id"]
    out = {"campaign_id": camp, "adset_id": adset}
    if ad:
        creative = api("POST", f"{acc}/adcreatives", **ad["creative"])["id"]
        out["creative_id"] = creative
        out["ad_id"] = api("POST", f"{acc}/ads", name=ad["name"], adset_id=adset,
                           creative={"creative_id": creative}, status="PAUSED")["id"]
    log("create", {"spec": a.spec, **out})
    print("Đã tạo (PAUSED): " + json.dumps(out))


def cmd_upload_image(a):
    with open(a.file, "rb") as f:
        r = requests.post(f"{BASE}/{a.account}/adimages", files={"filename": f}, timeout=120).json()
    if "error" in r:
        sys.exit(r["error"].get("message"))
    for name, img in r["images"].items():
        print(f"image_hash={img['hash']}  ({name})")


def cmd_set_status(a):
    obj = api("GET", a.id, fields="name,effective_status")
    if a.status == "ACTIVE" and not a.confirm:
        sys.exit(f"Cần --confirm để BẬT '{obj['name']}' (đang {obj['effective_status']}). Chỉ dùng khi user đã đồng ý rõ ràng.")
    api("POST", a.id, status=a.status)
    log("set_status", {"id": a.id, "name": obj["name"], "from": obj["effective_status"], "to": a.status})
    print(f"{obj['name']}: {obj['effective_status']} → {a.status}")


def cmd_set_budget(a):
    obj = api("GET", a.id, fields="name,daily_budget")
    old = int(obj.get("daily_budget") or 0)
    new = int(a.daily_budget)
    if not old:
        sys.exit("Object này không có daily_budget (có thể budget nằm ở campaign/CBO hoặc lifetime).")
    pct = (new - old) / old * 100
    lim = CFG["guardrails"]["max_budget_change_pct"]
    if abs(pct) > lim and not a.force:
        sys.exit(f"Chặn: thay đổi {pct:+.0f}% > {lim}%. Thay đổi lớn làm reset learning. Dùng --force nếu user đồng ý.")
    if not a.confirm:
        sys.exit(f"Xem trước: '{obj['name']}' {money(old)} → {money(new)} ({pct:+.0f}%). Thêm --confirm sau khi user đồng ý.")
    api("POST", a.id, daily_budget=new)
    log("set_budget", {"id": a.id, "name": obj["name"], "from": old, "to": new})
    print(f"{obj['name']}: {money(old)} → {money(new)} ({pct:+.0f}%)")


def main():
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    sp.add_parser("accounts")
    for name in ("report", "audit"):
        q = sp.add_parser(name)
        q.add_argument("--account", required=True)
        q.add_argument("--preset", default="last_7d")
        if name == "report":
            q.add_argument("--level", default="campaign", choices=["campaign", "adset", "ad"])
            q.add_argument("--json", action="store_true")
    q = sp.add_parser("inspect"); q.add_argument("--id", required=True)
    q.add_argument("--fields", default="name,status,effective_status,objective,daily_budget,optimization_goal,targeting,promoted_object")
    q = sp.add_parser("copy"); q.add_argument("--id", required=True); q.add_argument("--name"); q.add_argument("--daily-budget")
    q = sp.add_parser("create"); q.add_argument("--spec", required=True); q.add_argument("--dry-run", action="store_true")
    q = sp.add_parser("upload-image"); q.add_argument("--account", required=True); q.add_argument("--file", required=True)
    q = sp.add_parser("set-status"); q.add_argument("--id", required=True)
    q.add_argument("--status", required=True, choices=["ACTIVE", "PAUSED"]); q.add_argument("--confirm", action="store_true")
    q = sp.add_parser("set-budget"); q.add_argument("--id", required=True); q.add_argument("--daily-budget", required=True)
    q.add_argument("--confirm", action="store_true"); q.add_argument("--force", action="store_true")
    a = p.parse_args()
    globals()["cmd_" + a.cmd.replace("-", "_")](a)


if __name__ == "__main__":
    main()
