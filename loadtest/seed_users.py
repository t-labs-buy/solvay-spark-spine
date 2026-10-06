"""Create (or reset) the accounts the load test signs in as.

    LOADTEST_PASSWORD=... ADMIN_USERNAME=... ADMIN_PASSWORD=... \
        python seed_users.py --host http://localhost:8000 --count 20

Signs in as the admin, then creates loadtest-01..N with role `user`, and with
--admin also loadtest-admin with role `admin` (the Quality dashboard is admin
only). An account that already exists has its password reset to
LOADTEST_PASSWORD and is reactivated, so running this twice is safe. Only
loadtest-* accounts are ever created or changed. They are exempt from the
change-your-password-at-first-sign-in rule, since a script signs in as them.
Standard library only, so it runs from either venv.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request


def client(host: str):
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(method: str, path: str, body: dict | None = None):
        req = urllib.request.Request(host.rstrip("/") + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=30) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"null")

    return call


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--host", default="http://localhost:8000")
    ap.add_argument("--count", type=int, default=int(os.environ.get("LOADTEST_ACCOUNTS", "20")))
    ap.add_argument("--admin", action="store_true",
                    help="also create loadtest-admin, with the admin role")
    args = ap.parse_args()

    password = os.environ.get("LOADTEST_PASSWORD", "")
    admin, admin_password = os.environ.get("ADMIN_USERNAME", ""), os.environ.get("ADMIN_PASSWORD", "")
    if not (password and admin and admin_password):
        sys.exit("Set LOADTEST_PASSWORD, ADMIN_USERNAME and ADMIN_PASSWORD.")

    call = client(args.host)
    status, body = call("POST", "/api/auth/login", {"username": admin, "password": admin_password})
    if status != 200:
        sys.exit(f"Admin sign-in failed: HTTP {status} {body}")

    status, body = call("GET", "/api/admin/users")
    if status != 200:
        sys.exit(f"Listing users failed (is {admin} an admin?): HTTP {status} {body}")
    existing = {u["username"]: u for u in body["users"]}

    wanted = [(f"loadtest-{n:02d}", "user") for n in range(1, args.count + 1)]
    if args.admin:
        wanted.append(("loadtest-admin", "admin"))
    for name, role in wanted:
        if name in existing:
            status, body = call("PATCH", f"/api/admin/users/{existing[name]['id']}",
                                {"password": password, "active": True, "role": role,
                                 "must_change_password": False})
            verb = "reset"
        else:
            status, body = call("POST", "/api/admin/users",
                                {"username": name, "password": password, "role": role,
                                 "must_change_password": False})
            verb = "created"
        if status != 200:
            sys.exit(f"{name}: HTTP {status} {body}")
        print(f"{verb:8} {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
