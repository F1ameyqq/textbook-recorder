#!/usr/bin/env python3
"""Run selected indexed book images through local CPU OCR, keeping provenance.

This is text OCR, not question splitting, answer pairing, or formula recognition.
Model files may be downloaded once by PaddleOCR unless local directories are set.
"""

from __future__ import annotations

import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone


SCRIPT_VERSION = 1
DET_MODEL = "PP-OCRv5_mobile_det"
REC_MODEL = "PP-OCRv5_mobile_rec"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def serializable(value):
    if isinstance(value, dict):
        return {str(key): serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serializable(item) for item in value]
    if hasattr(value, "tolist"):
        return serializable(value.tolist())
    if hasattr(value, "item"):
        return serializable(value.item())
    return value


def atomic_text(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline="\n", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def atomic_json(path, value):
    atomic_text(path, json.dumps(serializable(value), ensure_ascii=False, indent=2) + "\n")


def parse_pages(value):
    pages = set()
    for segment in value.split(","):
        segment = segment.strip()
        if not segment:
            continue
        if "-" in segment:
            low, high = (int(item) for item in segment.split("-", 1))
            if low <= 0 or high < low:
                raise argparse.ArgumentTypeError("Invalid positive page range")
            pages.update(range(low, high + 1))
        else:
            page = int(segment)
            if page <= 0:
                raise argparse.ArgumentTypeError("Pages must be positive")
            pages.add(page)
    if not pages:
        raise argparse.ArgumentTypeError("Select at least one page")
    return sorted(pages)


def package_versions():
    versions = {}
    for package in ("paddlepaddle", "paddleocr", "paddlex", "numpy", "Pillow"):
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            versions[package] = None
    return versions


def extract_lines(result):
    payload = result.get("res", result)
    texts = payload.get("rec_texts", [])
    scores = payload.get("rec_scores", [])
    polygons = payload.get("rec_polys", [])
    boxes = payload.get("rec_boxes", [])
    if len(texts) != len(scores):
        raise ValueError("OCR text and score counts differ")
    if polygons and len(polygons) != len(texts):
        raise ValueError("OCR polygon and text counts differ")
    if boxes and len(boxes) != len(texts):
        raise ValueError("OCR bounding box and text counts differ")
    lines = []
    for position, text in enumerate(texts):
        polygon = polygons[position] if polygons else None
        box = boxes[position] if boxes else None
        if box is None and polygon:
            xs, ys = zip(*polygon)
            box = [min(xs), min(ys), max(xs), max(ys)]
        if box is None:
            raise ValueError("OCR result contains text without a source bounding box")
        lines.append({
            "index": position, "text": text, "score": scores[position],
            "bbox": box, "polygon": polygon,
        })
    return lines


def clean_text(value):
    # Do not normalize Unicode, change digits, fix words, or interpret formulas.
    return re.sub(r"[ \t]+", " ", value.replace("\r\n", "\n").replace("\r", "\n")).strip()


def artifacts_for(output, page):
    stem = f"page-{page:04d}"
    return {
        "raw": output / f"{stem}.raw.json",
        "clean": output / f"{stem}.clean.json",
        "text": output / f"{stem}.clean.txt",
    }


def finished_matches(previous, source_hash, configuration_hash, artifacts):
    if (
        previous.get("status") != "complete"
        or previous.get("inputSha256") != source_hash
        or previous.get("configurationSha256") != configuration_hash
    ):
        return False
    stored = previous.get("artifacts", {})
    return all(
        path.is_file() and stored.get(kind, {}).get("sha256") == digest_file(path)
        for kind, path in artifacts.items()
    )


def run(args):
    index_path = args.index.resolve()
    book_root = index_path.parent
    index = json.loads(index_path.read_text(encoding="utf-8-sig"))
    by_page = {}
    for entry in index.get("pages", []):
        page = int(entry["systemPage"])
        if page in by_page:
            raise ValueError(f"Duplicate systemPage in index: {page}")
        by_page[page] = entry
    output = (args.output or book_root / "ocr").resolve()
    model_cache = (args.model_cache or book_root.parent / "ocr-models").resolve()
    versions = package_versions()
    settings = {
        "scriptVersion": SCRIPT_VERSION, "device": "cpu",
        "textDetectionModel": DET_MODEL, "textRecognitionModel": REC_MODEL,
        "detModelDir": str(args.det_model_dir.resolve()) if args.det_model_dir else None,
        "recModelDir": str(args.rec_model_dir.resolve()) if args.rec_model_dir else None,
        "modelCache": str(model_cache),
        "documentOrientation": False, "documentUnwarping": False,
        "textlineOrientation": False, "enableMKLDNN": False, "packages": versions,
    }
    configuration_hash = hashlib.sha256(
        json.dumps(settings, sort_keys=True).encode("utf-8")
    ).hexdigest()
    journal_path = output / "status.json"
    journal = (
        json.loads(journal_path.read_text(encoding="utf-8")) if journal_path.exists()
        else {"schemaVersion": 1, "bookId": index.get("bookId"), "pages": {}}
    )
    if journal.get("schemaVersion") != 1 or not isinstance(journal.get("pages"), dict):
        raise ValueError("Unrecognized OCR status journal")
    journal.setdefault("failureHistory", [])
    jobs = []
    summary = {"selected": args.pages, "skipped": [], "notReady": [], "failed": [], "completed": []}

    def save_journal():
        if not args.dry_run:
            for page, state in journal["pages"].items():
                if state.get("status") == "failed":
                    retained = {"systemPage": int(page), **state}
                    if retained not in journal["failureHistory"]:
                        journal["failureHistory"].append(retained)
            journal["updatedAt"] = utc_now()
            atomic_json(journal_path, journal)

    for page in args.pages:
        entry = by_page.get(page)
        if entry is None:
            summary["notReady"].append(page)
            journal["pages"][str(page)] = {"status": "not_ready", "reason": "Page not yet in index", "at": utc_now()}
            continue
        try:
            image = (book_root / entry["file"]).resolve()
            if not image.is_relative_to(book_root) or image.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                raise ValueError("Index image path must stay in the book directory and be JPEG/PNG")
            if not image.is_file():
                summary["notReady"].append(page)
                journal["pages"][str(page)] = {"status": "not_ready", "reason": "Image missing", "at": utc_now()}
                continue
            source_hash = digest_file(image)
            if source_hash != entry.get("sha256"):
                raise ValueError("Image SHA256 differs from the download index")
            artifacts = artifacts_for(output, page)
            previous = journal["pages"].get(str(page), {})
            if not args.force and finished_matches(previous, source_hash, configuration_hash, artifacts):
                summary["skipped"].append(page)
                continue
            if (
                not args.force and not args.retry_failed
                and previous.get("status") == "failed"
                and previous.get("inputSha256") == source_hash
                and previous.get("configurationSha256") == configuration_hash
            ):
                summary["failed"].append(page)
                print(f"page {page}: previous failure retained; use --retry-failed", flush=True)
                continue
            jobs.append((page, entry, image, source_hash, artifacts))
        except Exception as error:
            summary["failed"].append(page)
            journal["pages"][str(page)] = {
                "status": "failed", "at": utc_now(), "phase": "source_validation",
                "error": f"{type(error).__name__}: {error}",
            }
    save_journal()
    if args.dry_run:
        summary["wouldProcess"] = [job[0] for job in jobs]
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return 1 if summary["failed"] else (2 if summary["notReady"] else 0)
    if not jobs:
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return 1 if summary["failed"] else (2 if summary["notReady"] else 0)

    for page, entry, image, source_hash, artifacts in jobs:
        journal["pages"][str(page)] = {
            "status": "initializing", "startedAt": utc_now(), "systemPage": page,
            "inputSha256": source_hash, "configurationSha256": configuration_hash,
        }
    save_journal()
    initialize_start = time.perf_counter()
    try:
        # One documented model source. No automatic source-switching loop.
        os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")
        os.environ["PADDLE_PDX_CACHE_HOME"] = str(model_cache)
        # This flag is implemented by the installed PaddleX flags/hoster code.
        # Avoid unrelated hoster probes; required weights still download once.
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        if args.offline and not all(path.is_dir() for path in (args.det_model_dir, args.rec_model_dir)):
            raise ValueError("Offline mode requires existing local model directories")
        from paddleocr import PaddleOCR
        arguments = {
            "device": "cpu", "text_detection_model_name": DET_MODEL,
            "text_recognition_model_name": REC_MODEL,
            "use_doc_orientation_classify": False, "use_doc_unwarping": False,
            "use_textline_orientation": False,
            # Windows Paddle 3.3 oneDNN raised an unsupported PIR attribute on
            # the actual sample. Plain CPU inference avoids that optimizer.
            "enable_mkldnn": False,
        }
        if args.det_model_dir:
            arguments["text_detection_model_dir"] = str(args.det_model_dir.resolve())
        if args.rec_model_dir:
            arguments["text_recognition_model_dir"] = str(args.rec_model_dir.resolve())
        pipeline = PaddleOCR(**arguments)
    except Exception as error:
        detail = traceback.format_exc()
        for page, entry, image, source_hash, artifacts in jobs:
            journal["pages"][str(page)] = {
                "status": "failed", "at": utc_now(), "phase": "initialization",
                "inputSha256": source_hash, "configurationSha256": configuration_hash,
                "error": f"{type(error).__name__}: {error}", "traceback": detail,
            }
            summary["failed"].append(page)
        save_journal()
        print(detail, file=sys.stderr, flush=True)
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return 1
    initialize_seconds = time.perf_counter() - initialize_start
    journal["engine"] = settings
    journal["lastInitializationSeconds"] = round(initialize_seconds, 4)
    print(f"Local CPU OCR initialized in {initialize_seconds:.3f}s; pages: {[job[0] for job in jobs]}", flush=True)
    for page, entry, image, source_hash, artifacts in jobs:
        state = {
            "status": "running", "startedAt": utc_now(), "systemPage": page,
            "inputSha256": source_hash, "configurationSha256": configuration_hash,
        }
        journal["pages"][str(page)] = state
        save_journal()
        start = time.perf_counter()
        try:
            results = list(pipeline.predict(input=str(image)))
            if len(results) != 1:
                raise ValueError(f"Expected one image result, received {len(results)}")
            result = results[0].json
            if isinstance(result, str):
                result = json.loads(result)
            result = serializable(result)
            lines = extract_lines(result)
            if digest_file(image) != source_hash:
                raise ValueError("Source image changed during OCR")
            elapsed = time.perf_counter() - start
            provenance = {
                "schemaVersion": 1, "bookId": index.get("bookId"), "systemPage": page,
                "source": {"file": entry["file"], "sha256": source_hash,
                           "width": entry.get("width"), "height": entry.get("height")},
                "engine": settings, "configurationSha256": configuration_hash,
                "generatedAt": utc_now(), "inferenceSeconds": round(elapsed, 4),
            }
            atomic_json(artifacts["raw"], {**provenance, "lines": lines, "result": result})
            cleaned = [{**line, "rawText": line["text"], "text": clean_text(line["text"])} for line in lines]
            text = "\n".join(line["text"] for line in cleaned if line["text"])
            atomic_json(artifacts["clean"], {
                **provenance, "lines": cleaned, "text": text,
                "cleaning": "Trim surrounding whitespace and collapse ASCII spaces/tabs only; retain OCR order",
                "limitations": ["No layout or question reconstruction", "No formula recognition", "No answer pairing", "Not proof of source accuracy"],
            })
            atomic_text(artifacts["text"], text + ("\n" if text else ""))
            scores = [float(line["score"]) for line in lines]
            state.update({
                "status": "complete", "completedAt": utc_now(), "inferenceSeconds": round(elapsed, 4),
                "lineCount": len(lines), "lowScoreLineCount": sum(score < 0.8 for score in scores),
                "meanRecognitionScore": round(sum(scores) / len(scores), 6) if scores else None,
                "artifacts": {kind: {"file": str(path.relative_to(output)), "sha256": digest_file(path)} for kind, path in artifacts.items()},
            })
            summary["completed"].append(page)
            print(f"page {page}: {len(lines)} lines in {elapsed:.3f}s; {state['lowScoreLineCount']} lines score < 0.8", flush=True)
        except Exception as error:
            state.update({
                "status": "failed", "failedAt": utc_now(), "phase": "inference_or_output",
                "elapsedSeconds": round(time.perf_counter() - start, 4),
                "error": f"{type(error).__name__}: {error}", "traceback": traceback.format_exc(),
            })
            summary["failed"].append(page)
            print(f"page {page}: {state['error']}", file=sys.stderr, flush=True)
        save_journal()
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 1 if summary["failed"] else (2 if summary["notReady"] else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, required=True, help="Authorized downloaded book index.json")
    parser.add_argument("--pages", type=parse_pages, required=True, help="Explicit pages, e.g. 11 or 10,11,243; ranges accepted")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--det-model-dir", type=Path, help="Existing local detection model directory")
    parser.add_argument("--rec-model-dir", type=Path, help="Existing local recognition model directory")
    parser.add_argument("--model-cache", type=Path, help="Local model cache; defaults to a sibling ocr-models directory in data")
    parser.add_argument("--offline", action="store_true", help="Require both existing local model directories and skip hoster connectivity probes")
    parser.add_argument("--force", action="store_true", help="Reprocess explicitly selected pages")
    parser.add_argument("--retry-failed", action="store_true", help="Retry explicitly selected previous failures once")
    parser.add_argument("--dry-run", action="store_true", help="Check selection, source hashes and resume state without importing models or writing outputs")
    args = parser.parse_args()
    if args.offline and (args.det_model_dir is None or args.rec_model_dir is None):
        parser.error("--offline requires --det-model-dir and --rec-model-dir")
    try:
        return run(args)
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
