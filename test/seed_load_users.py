"""
Pre-register load-test users and mint JWT tokens (one-time, offline).

Usage:
  python test/seed_load_users.py --count 2000
  python test/seed_load_users.py --count 2000 --tokens-out test/.load-tokens.json
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests


def _ensure_token(host: str, prefix: str, index: int, password: str) -> tuple[int, str, str | None, str | None]:
    username = f"{prefix}_{index:04d}"
    try:
        register = requests.post(
            f"{host}/v1/register",
            json={"username": username, "password": password},
            timeout=60,
        )
        if register.status_code not in (200, 400):
            return index, username, None, f"register {register.status_code}: {register.text}"
        if register.status_code == 400 and "taken" not in register.text.lower():
            return index, username, None, f"register 400: {register.text}"

        login = requests.post(
            f"{host}/v1/login",
            json={"username": username, "password": password},
            timeout=60,
        )
    except requests.RequestException as exc:
        return index, username, None, str(exc)

    if login.status_code != 200:
        return index, username, None, f"login {login.status_code}: {login.text}"

    return index, username, login.json()["access_token"], None


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-register load test users and mint JWT tokens")
    parser.add_argument("--host", default="http://127.0.0.1:8000")
    parser.add_argument("--count", type=int, default=1000)
    parser.add_argument("--prefix", default="load_ws")
    parser.add_argument("--password", default="loadpass123")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument(
        "--tokens-out",
        default="",
        help="Write username/token pairs for LOAD_AUTH_MODE=token (recommended for WS load tests)",
    )
    args = parser.parse_args()

    errors: list[str] = []
    tokens_by_index: dict[int, tuple[str, str]] = {}

    print(f"Seeding {args.count} users as {args.prefix}_XXXX on {args.host} ...")

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [
            pool.submit(_ensure_token, args.host, args.prefix, i, args.password)
            for i in range(args.count)
        ]
        for idx, future in enumerate(as_completed(futures), start=1):
            index, username, token, error = future.result()
            if error:
                errors.append(f"{username}: {error}")
            elif token:
                tokens_by_index[index] = (username, token)

            if idx % 100 == 0 or idx == args.count:
                print(
                    f"  {idx}/{args.count} done "
                    f"(tokens={len(tokens_by_index)}, errors={len(errors)})"
                )

    if errors:
        print(f"\n{len(errors)} error(s); first few:", file=sys.stderr)
        for line in errors[:5]:
            print(f"  {line}", file=sys.stderr)
        return 1

    if len(tokens_by_index) != args.count:
        print(f"ERROR: expected {args.count} tokens, got {len(tokens_by_index)}", file=sys.stderr)
        return 1

    print(f"\nDone: {len(tokens_by_index)} users with tokens")

    if args.tokens_out:
        out_path = Path(args.tokens_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "host": args.host,
            "prefix": args.prefix,
            "users": [
                {"username": tokens_by_index[i][0], "token": tokens_by_index[i][1]}
                for i in range(args.count)
            ],
        }
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"Wrote tokens to {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
