"""Bundle public sources and the built application image without local settings."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
config = json.loads((root / "miniprogram/project.config.json").read_text(encoding="utf-8-sig"))
if config.get("appid") != "touristappid":
    raise SystemExit("Public source must use the placeholder AppID before packaging")
output = root / "output"
output.mkdir(exist_ok=True)
target = output / "esp32-s3-campus-card.zip"
excluded = {".git", ".pio", ".local", ".tools", ".vscode", ".playwright-cli", ".playwright", "output", "node_modules", "__pycache__"}
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob("*")):
        relative = file.relative_to(root)
        if not file.is_file() or file.is_symlink() or any(part in excluded for part in relative.parts):
            continue
        if file.name in {"project.private.config.json", "project.local.config.json"} or file.suffix in {".exe", ".log", ".pyc"}:
            continue
        archive.write(file, (Path(root.name) / relative).as_posix())
    firmware = output / "firmware.bin"
    if firmware.is_file():
        archive.write(firmware, root.name + "/output/firmware.bin")
print("Created output/esp32-s3-campus-card.zip (local configuration excluded)")
