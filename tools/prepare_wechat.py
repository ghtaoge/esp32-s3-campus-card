"""Create a local WeChat workspace at this project's .local/wechat only."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys


def checked_directory(path, *, must_exist=False):
    """Reject redirected paths before copying or replacing generated files."""
    is_junction = getattr(path, "is_junction", lambda: False)
    if path.is_symlink() or is_junction() or path.resolve() != path:
        raise ValueError("Refusing a linked or redirected workspace path")
    if path.exists() and not path.is_dir():
        raise ValueError("Expected a directory at the workspace path")
    if must_exist and not path.is_dir():
        raise ValueError("The miniprogram source directory does not exist")


def prepare(appid):
    if not re.fullmatch(r"wx[0-9a-fA-F]{16}", appid):
        raise ValueError("Expected wx followed by exactly 16 hexadecimal characters")

    root = Path(__file__).resolve().parents[1]
    source = root / "miniprogram"
    local = root / ".local"
    target = local / "wechat"
    checked_directory(source, must_exist=True)
    checked_directory(local)
    checked_directory(target)
    # The script has no output-directory option. Keep this check before deletion.
    if target.resolve() != root / ".local" / "wechat":
        raise ValueError("Refusing output outside this project's .local/wechat")

    # Read and validate source before replacing a previously generated workspace.
    config_path = source / "project.config.json"
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    if not isinstance(config, dict):
        raise ValueError("project.config.json must contain a JSON object")
    for parent, directories, files in os.walk(source, followlinks=False):
        for name in directories + files:
            item = Path(parent) / name
            is_junction = getattr(item, "is_junction", lambda: False)
            if item.is_symlink() or is_junction() or not item.resolve().is_relative_to(source):
                raise ValueError("Refusing linked files in miniprogram source")

    config["appid"] = appid
    local.mkdir(exist_ok=True)
    # target is an exact, verified child of this project. No other path is removed.
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns(
            "tests", "node_modules", "project.private.config.json", "project.local.config.json"
        ),
    )
    (target / "project.config.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("Prepared .local/wechat. Import this directory in WeChat DevTools.")
    print("Public miniprogram source was not changed; rerun after source updates.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--appid", default=os.environ.get("WECHAT_APPID"))
    args = parser.parse_args()
    appid = args.appid
    if not appid:
        if not sys.stdin.isatty():
            parser.error("Pass --appid or set WECHAT_APPID")
        appid = input("WeChat AppID: ").strip()
    try:
        prepare(appid)
    except (ValueError, OSError, shutil.Error) as error:
        # Do not echo AppID, source file contents, or exception paths.
        print("Preparation failed ({}). {}".format(type(error).__name__,
              str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
              else "Check source configuration and workspace permissions."), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
