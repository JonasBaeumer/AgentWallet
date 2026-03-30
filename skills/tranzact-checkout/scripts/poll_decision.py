#!/usr/bin/env python3
"""
Background polling script for Tranzact approval decisions.

Launched by the OpenClaw agent after submitting a purchase quote.
Polls the Tranzact API for the user's approve/reject decision,
then wakes the agent via `openclaw system event` with the result
embedded in the event text as JSON.

Usage:
    ./poll_decision.py <intentId>

Requires environment variables:
    TRANZACT_BASE_URL   - Base URL of the Tranzact server
    TRANZACT_WORKER_KEY - Shared secret for agent API auth
"""

import json
import os
import subprocess
import sys
import time

import requests

# --- Config ---
BASE_URL = os.getenv("TRANZACT_BASE_URL", "").rstrip("/")
WORKER_KEY = os.getenv("TRANZACT_WORKER_KEY", "")
INTENT_ID = sys.argv[1] if len(sys.argv) > 1 else None

POLL_INTERVAL_SECS = 5
MAX_POLLS = 120  # 10 minutes total
MAX_CONSECUTIVE_ERRORS = 10  # bail after this many network failures in a row
WAKE_RETRIES = 3


def wake_agent(payload: dict) -> None:
    """Send a system event to wake OpenClaw with the decision data.
    Retries up to WAKE_RETRIES times — if wake fails, the agent
    never resumes and the user gets no feedback."""
    text = f"[Tranzact Alert]: {json.dumps(payload)}"
    for attempt in range(1, WAKE_RETRIES + 1):
        try:
            subprocess.run(
                [
                    "openclaw", "system", "event",
                    "--text", text,
                    "--mode", "now",
                ],
                check=True,
                timeout=10,
            )
            return  # success
        except Exception as e:
            print(
                f"[poll_decision] wake attempt {attempt}/{WAKE_RETRIES} failed: {e}",
                file=sys.stderr,
            )
            if attempt < WAKE_RETRIES:
                time.sleep(2)

    print("[poll_decision] CRITICAL: all wake attempts failed", file=sys.stderr)


def poll() -> int:
    """
    Poll GET /v1/agent/decision/<intentId> until resolved or timeout.

    Returns:
        0 - approved
        1 - denied
        2 - timeout
        3 - error
    """
    url = f"{BASE_URL}/v1/agent/decision/{INTENT_ID}"
    headers = {"X-Worker-Key": WORKER_KEY}
    consecutive_errors = 0

    for i in range(MAX_POLLS):
        try:
            r = requests.get(url, headers=headers, timeout=10)

            if r.status_code == 200:
                consecutive_errors = 0
                data = r.json()
                status = data.get("status")

                if status == "APPROVED":
                    wake_agent(data)
                    return 0

                elif status == "DENIED":
                    wake_agent({"status": "DENIED", "intentId": INTENT_ID})
                    return 1

                elif status == "EXPIRED":
                    wake_agent({"status": "ERROR", "intentId": INTENT_ID, "error": "Intent expired"})
                    return 3

                elif status == "FAILED":
                    wake_agent({"status": "ERROR", "intentId": INTENT_ID, "error": "Intent failed"})
                    return 3

                elif status == "AWAITING_APPROVAL":
                    pass  # keep polling

                else:
                    wake_agent({"status": "ERROR", "intentId": INTENT_ID, "error": f"Unexpected status: {status}"})
                    return 3

            elif r.status_code == 404:
                wake_agent({"status": "ERROR", "intentId": INTENT_ID, "error": "Intent not found"})
                return 3

            elif r.status_code == 401:
                wake_agent({"status": "ERROR", "intentId": INTENT_ID, "error": "Authentication failed (401)"})
                return 3

            elif r.status_code == 429:
                consecutive_errors += 1
                retry_after = int(r.headers.get("Retry-After", 30))
                print(
                    f"[poll_decision] poll {i+1} rate limited, backing off {retry_after}s",
                    file=sys.stderr,
                )
                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                    wake_agent({
                        "status": "ERROR",
                        "intentId": INTENT_ID,
                        "error": "Rate limited too many times",
                    })
                    return 3
                time.sleep(retry_after)
                continue

            else:
                consecutive_errors += 1
                print(
                    f"[poll_decision] poll {i+1} unexpected HTTP {r.status_code}",
                    file=sys.stderr,
                )
                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                    wake_agent({
                        "status": "ERROR",
                        "intentId": INTENT_ID,
                        "error": f"Too many HTTP errors (last: {r.status_code})",
                    })
                    return 3

        except requests.RequestException as e:
            consecutive_errors += 1
            print(f"[poll_decision] poll {i+1} failed: {e}", file=sys.stderr)

            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                wake_agent({
                    "status": "ERROR",
                    "intentId": INTENT_ID,
                    "error": f"Server unreachable after {MAX_CONSECUTIVE_ERRORS} consecutive failures",
                })
                return 3

        time.sleep(POLL_INTERVAL_SECS)

    # Timeout
    wake_agent({"status": "TIMEOUT", "intentId": INTENT_ID})
    return 2


if __name__ == "__main__":
    if not BASE_URL:
        print("[poll_decision] TRANZACT_BASE_URL not set", file=sys.stderr)
        sys.exit(1)
    if not WORKER_KEY:
        print("[poll_decision] TRANZACT_WORKER_KEY not set", file=sys.stderr)
        sys.exit(1)
    if not INTENT_ID:
        print("[poll_decision] Usage: poll_decision.py <intentId>", file=sys.stderr)
        sys.exit(1)

    sys.exit(poll())
