"""Command line: python -m luxbound [run|dev|seed|rules|mail-test EMAIL]. With no command, runs the portal."""
import argparse
import json
import os
import sys
import threading
import time

from dotenv import load_dotenv


def start_scheduler():
    """Run the early-warning rules every RULES_INTERVAL_MIN minutes (and once shortly after start)."""
    from .rules import run_rules

    every = float(os.environ.get("RULES_INTERVAL_MIN") or 15) * 60

    def loop():
        time.sleep(3)
        while True:
            try:
                print("[rules]", json.dumps(run_rules()), flush=True)
            except Exception as err:  # noqa: BLE001 — keep the scheduler alive
                print("[rules] failed:", err, file=sys.stderr, flush=True)
            time.sleep(every)

    threading.Thread(target=loop, name="rules", daemon=True).start()


def main(argv=None):
    load_dotenv()
    parser = argparse.ArgumentParser(prog="python -m luxbound", description="LuxDevHQ Progress & Support")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("run", help="start the portal (default)")
    sub.add_parser("dev", help="start with auto-reload on code changes")
    sub.add_parser("seed", help="reset the database and load the Cohort 9 demo")
    sub.add_parser("rules", help="run the early-warning rules once")
    mt = sub.add_parser("mail-test", help="send a test email using your SMTP settings")
    mt.add_argument("email")
    args = parser.parse_args(argv)

    from . import create_app

    if args.cmd == "seed":
        from .seed import PASSWORD, seed

        print("Seeded Cohort 9. Rules:", json.dumps(seed(), indent=2))
        print(f'\nSign in with password "{PASSWORD}":')
        print("  Cohort lead  lead@luxdevhq.test")
        print("  Tutor        brian@luxdevhq.test  /  wanjiru@luxdevhq.test")
        print("  Students     achieng@students.test, kevin@…, faith@…, daniel@…, grace@…, samuel@…, mercy@…, ian@students.test")
        return
    if args.cmd == "rules":
        from .rules import run_rules

        print(json.dumps(run_rules(), indent=2))
        return
    if args.cmd == "mail-test":
        from .mailer import send_mail, transport_name

        if transport_name() != "smtp":
            sys.exit("SMTP_HOST is not set in .env — emails are only recorded in the outbox.")
        try:
            send_mail(args.email, "LuxDevHQ Progress & Support — test email", "If you can read this, email sending works.")
        except Exception as err:  # noqa: BLE001
            sys.exit(f"Sending failed: {err}")
        print(f"Sent to {args.email}.")
        return

    port = int(os.environ.get("PORT") or 3000)
    host = os.environ.get("HOST") or "127.0.0.1"
    app = create_app()
    if args.cmd == "dev":
        if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
            start_scheduler()
        app.run(host=host, port=port, debug=True)
        return
    start_scheduler()
    from waitress import serve

    print(f"LuxDevHQ Progress & Support → http://localhost:{port}", flush=True)
    serve(app, host=host, port=port, threads=8)


if __name__ == "__main__":
    main()
