"""Extract original PNG/JPEG pixels; no recognition, redrawing or model calls."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def contained(root, target):
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def safe_path(root, requested):
    root = root.resolve(strict=True)
    target = Path(os.path.abspath(root / requested))
    if not contained(root, target) or target == root:
        raise ValueError("Path must stay within the job directory")
    # Resolve every existing ancestor, including junctions and dangling links.
    current = target
    while True:
        if current.exists() or current.is_symlink():
            real = current.resolve(strict=True)
            if not contained(root, real):
                raise ValueError("Symlink/junction leaves the job directory")
            break
        if current == root:
            break
        current = current.parent
    return target


def job_file(project, requested):
    project = Path(project).resolve(strict=True)
    trusted = project / "data" / "jobs"
    target = Path(os.path.abspath(project / requested))
    if not contained(trusted, target) or len(target.relative_to(trusted).parts) != 2:
        raise ValueError("Preparation files must be in data/jobs/<job>/")
    # No alternate physical data/jobs root is permitted.
    safe_path(project, target)
    parent = target.parent.resolve(strict=True)
    if not contained(trusted, parent) or len(parent.relative_to(trusted).parts) != 1:
        raise ValueError("Job symlink/junction leaves data/jobs")
    return safe_path(parent, target.name)


def read_json(file):
    raw = file.read_bytes()
    return json.loads(raw.decode("utf-8-sig")), raw


def crop_sources(project, plan_name, output_name):
    from PIL import Image
    plan_path = job_file(project, plan_name)
    output = job_file(project, output_name)
    base = plan_path.parent.resolve(strict=True)
    if output.parent.resolve(strict=True) != base:
        raise ValueError("Plan and output must share one job directory")
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; use a new plan/output")
    plan, _ = read_json(plan_path)
    if plan.get("schemaVersion") != 1 or type(plan.get("bookId")) is not int or plan["bookId"] <= 0:
        raise ValueError("Invalid plan schemaVersion/bookId")
    reference = plan.get("index", {})
    if not isinstance(reference, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(reference.get("sha256", ""))):
        raise ValueError("Index requires an exact SHA256")
    index_path = safe_path(base, reference.get("path", ""))
    index, index_bytes = read_json(index_path)
    if digest(index_bytes) != reference["sha256"] or index.get("schemaVersion") != 1 or index.get("bookId") != plan["bookId"]:
        raise ValueError("Index bytes/schema/bookId changed")
    pages = {}
    for entry in index.get("pages", []):
        page = entry.get("systemPage")
        if type(page) is not int or page <= 0 or page in pages:
            raise ValueError("Invalid or duplicate indexed page")
        pages[page] = entry
    crops = plan.get("crops")
    if not isinstance(crops, list) or not crops:
        raise ValueError("A nonempty explicit crops list is required")
    pending, seen = [], set()
    # Validate and render all outputs in memory before any writes.
    for item in crops:
        identifier = item.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", identifier) or identifier.casefold() in seen:
            raise ValueError("Invalid or duplicate crop ID")
        if identifier.casefold() in {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}:
            raise ValueError("Crop ID is a reserved device filename")
        seen.add(identifier.casefold())
        if item.get("purpose") not in ("diagram", "table"):
            raise ValueError("Only diagram/table crops are permitted")
        if type(item.get("page")) is not int or item["page"] not in pages:
            raise ValueError("Crop page is missing from the index")
        entry = pages[item["page"]]
        image_path = safe_path(base, entry.get("file", ""))
        source = image_path.read_bytes()
        if digest(source) != entry.get("sha256"):
            raise ValueError("Source image SHA256 changed")
        with Image.open(io.BytesIO(source)) as image:
            image.load()
            if image.format not in ("PNG", "JPEG") or image_path.suffix.lower() not in (".png", ".jpg", ".jpeg"):
                raise ValueError("Only indexed original PNG/JPEG pixels are accepted")
            if image.size != (entry.get("width"), entry.get("height")) or entry.get("bytes", len(source)) != len(source):
                raise ValueError("Actual image dimensions/bytes differ from index")
            box = item.get("bbox")
            if (not isinstance(box, list) or len(box) != 4 or any(type(x) is not int or x < 0 for x in box)
                    or box[0] >= box[2] or box[1] >= box[3] or box[2] > image.width or box[3] > image.height):
                raise ValueError("BBox must use valid original pixel coordinates")
            encoded = io.BytesIO()
            image.crop(tuple(box)).save(encoded, format="PNG")
        destination = safe_path(base, f"figures/{identifier}.png")
        if destination.exists() or destination.is_symlink():
            raise ValueError("Crop already exists; do not overwrite evidence")
        data = encoded.getvalue()
        evidence = {"id": identifier, "page": item["page"], "image": entry["file"],
                    "sourceSha256": entry["sha256"], "bbox": box, "file": f"figures/{identifier}.png",
                    "sha256": digest(data), "purpose": item["purpose"]}
        pending.append((destination, data, image_path, entry["sha256"], evidence))
    for _, _, image_path, expected, _ in pending:
        if digest(image_path.read_bytes()) != expected:
            raise ValueError("Original image changed during crop preparation")
    if digest(index_path.read_bytes()) != reference["sha256"]:
        raise ValueError("Index changed during crop preparation")
    for destination, data, _, _, _ in pending:
        destination.parent.mkdir(parents=True, exist_ok=True)
        safe_path(base, destination)
        with destination.open("xb") as handle:
            handle.write(data)
    evidence = {"schemaVersion": 1, "kind": "source-crops", "bookId": plan["bookId"],
                "indexSha256": reference["sha256"], "crops": [item[4] for item in pending],
                "semanticsVerifiedByTool": False}
    safe_path(base, output)
    with output.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return {"bookId": plan["bookId"], "crops": len(pending), "evidencePath": str(output),
            "sourceModified": False, "semanticsVerifiedByTool": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise ValueError("Python 3.11 or newer is required")
    result = crop_sources(Path(__file__).resolve().parents[1], args.plan, args.output)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
