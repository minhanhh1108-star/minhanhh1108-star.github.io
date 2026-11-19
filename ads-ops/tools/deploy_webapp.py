#!/usr/bin/env python3
"""Create/update the Apps Script project for ads-ops/webapp and deploy it as a web app via the Apps Script API.

Auth: an OAuth access token for the owner's Google account (scopes script.projects + script.deployments) is
injected by the session's network proxy for script.googleapis.com. This script never reads or prints a token.

Usage: python3 ads-ops/tools/deploy_webapp.py [--script-id ID] [--deployment-id ID]
"""
import argparse, json, os, sys
import requests

API = "https://script.googleapis.com/v1"
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "webapp")
FILES = [("appsscript", "JSON", "appsscript.json"), ("Code", "SERVER_JS", "Code.gs"), ("Meta", "SERVER_JS", "Meta.gs"),
         ("Validate", "SERVER_JS", "Validate.gs"), ("Sync", "SERVER_JS", "Sync.gs"), ("Build", "SERVER_JS", "Build.gs"), ("Report", "SERVER_JS", "Report.gs"), ("QC", "SERVER_JS", "QC.gs"),
         ("Index", "HTML", "Index.html"), ("Styles", "HTML", "Styles.html"), ("App", "HTML", "App.html"), ("Setup", "HTML", "Setup.html")]


def call(method, path, body=None):
    r = requests.request(method, API + path, json=body, timeout=120)
    try:
        data = r.json()
    except ValueError:
        data = {"raw": r.text[:500]}
    if r.status_code >= 300:
        msg = (data.get("error") or {}).get("message") if isinstance(data, dict) else data
        sys.exit(f"Apps Script API {method} {path} → HTTP {r.status_code}: {msg}")
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script-id")
    ap.add_argument("--deployment-id")
    ap.add_argument("--title", default="Lên camp Meta")
    a = ap.parse_args()
    script_id = a.script_id
    if not script_id:
        script_id = call("POST", "/projects", {"title": a.title})["scriptId"]
        print("Đã tạo dự án:", script_id)
    files = [{"name": n, "type": t, "source": open(os.path.join(SRC, f), encoding="utf-8").read()} for n, t, f in FILES]
    local = os.path.join(SRC, "Local.gs")  # gitignored per-install values (e.g. dashboard links); optional
    if os.path.exists(local):
        files.append({"name": "Local", "type": "SERVER_JS", "source": open(local, encoding="utf-8").read()})
    call("PUT", f"/projects/{script_id}/content", {"files": files})
    print("Đã tải", len(files), "file lên")
    ver = call("POST", f"/projects/{script_id}/versions", {"description": "Bản cập nhật từ Claude"})["versionNumber"]
    cfg = {"versionNumber": ver, "manifestFileName": "appsscript", "description": "Web app Lên camp Meta"}
    if a.deployment_id:
        dep = call("PUT", f"/projects/{script_id}/deployments/{a.deployment_id}", {"deploymentConfig": cfg})
    else:
        dep = call("POST", f"/projects/{script_id}/deployments", cfg)
    url = next((e["webApp"]["url"] for e in dep.get("entryPoints", []) if e.get("entryPointType") == "WEB_APP"), None)
    print(json.dumps({"scriptId": script_id, "deploymentId": dep["deploymentId"], "version": ver, "webAppUrl": url,
                      "editorUrl": f"https://script.google.com/d/{script_id}/edit"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
