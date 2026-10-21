"""Run one isolated OCR child with sampled shared-resource checks, not hard resource caps."""
import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time


class MemoryStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                ("totalPhys", ctypes.c_ulonglong), ("availPhys", ctypes.c_ulonglong),
                ("totalPage", ctypes.c_ulonglong), ("availPage", ctypes.c_ulonglong),
                ("totalVirtual", ctypes.c_ulonglong), ("availVirtual", ctypes.c_ulonglong),
                ("availExtended", ctypes.c_ulonglong)]


def resources():
    memory = MemoryStatus()
    memory.length = ctypes.sizeof(memory)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
        raise OSError("Cannot inspect available RAM")
    gpu = subprocess.run(["nvidia-smi.exe", "--query-gpu=memory.used,temperature.gpu,utilization.gpu",
                          "--format=csv,noheader,nounits", "--id=0"], capture_output=True, text=True,
                         timeout=8, creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    used, temperature, utilization = [int(value.strip()) for value in gpu.stdout.strip().split(",")]
    return {"freeRamMiB": round(memory.availPhys / 1048576), "totalGpuUsedMiB": used,
            "gpuTemperatureC": temperature, "totalGpuUtilizationPercent": utilization}


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def load_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def freeze_inputs(root, runner):
    files = {"truth": root / "samples" / "ground-truth.json",
             "review": root / "samples" / "TRUTH-REVIEW.json", "runner": runner,
             "guard": Path(__file__).resolve()}
    bindings = {role: {"path": file.name if role in ("runner", "guard") else file.relative_to(root).as_posix(),
                       "sha256": digest(file)} for role, file in files.items()}
    truth, review = load_json(files["truth"]), load_json(files["review"])
    if review.get("status") != "ACCEPTED_FINITE_REGION_TRUTH" or review.get("truthSha256") != bindings["truth"]["sha256"]:
        raise ValueError("A hash-bound independent truth review is required")
    samples = truth.get("samples")
    if truth.get("schemaVersion") != 1 or not isinstance(samples, list) or not 1 <= len(samples) <= 12:
        raise ValueError("Expected 1-12 reviewed truth regions")
    ids = [sample.get("id") for sample in samples]
    if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("Truth region IDs must be unique")
    for sample in samples:
        box = sample.get("bbox")
        if (sample.get("kind") not in ("text", "formula") or not isinstance(sample.get("sourceSha256"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", sample["sourceSha256"])
                or not isinstance(box, list) or len(box) != 4
                or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in box)
                or box[0] >= box[2] or box[1] >= box[3]):
            raise ValueError("Truth source/region geometry is incomplete")
    images = [sample.get("image") for sample in samples]
    if any(not isinstance(value, str) or not value or Path(value).name != value or "/" in value or "\\" in value for value in images):
        raise ValueError("Truth page names must be local filenames")
    expected = {"sampleCount": len(samples), "sampleIds": ids,
                "pageImages": list(dict.fromkeys(images)), "pageCount": len(set(images))}
    return files, bindings, truth, expected


def validate_completed_result(value, args, bindings, truth, expected):
    required = {"schemaVersion": 1, "mode": "full-page-inference-region-scoring", "status": "completed",
                "engine": args.engine, "device": args.device, "threads": 2, "cooldownSeconds": 2,
                "truthSha256": bindings["truth"]["sha256"], "truthReviewSha256": bindings["review"]["sha256"],
                "runnerSha256": bindings["runner"]["sha256"]}
    for key, wanted in required.items():
        if value.get(key) != wanted:
            raise ValueError("Result binding mismatch: " + key)
    samples, pages = value.get("samples"), value.get("pages")
    if not isinstance(samples, list) or len(samples) != expected["sampleCount"]:
        raise ValueError("Result does not contain the complete region count")
    by_id = {sample.get("id"): sample for sample in samples}
    if len(by_id) != expected["sampleCount"] or set(by_id) != set(expected["sampleIds"]):
        raise ValueError("Result region identities are incomplete or duplicated")
    for sample in truth["samples"]:
        actual = by_id[sample["id"]]
        if actual.get("status") != "ok" or not isinstance(actual.get("text"), str):
            raise ValueError("Result contains an unsuccessful region")
        if any(actual.get(key) != sample.get(key) for key in ("kind", "sourceSha256", "bbox")):
            raise ValueError("Result region source/geometry mismatch")
    if not isinstance(pages, list) or [page.get("image") for page in pages] != expected["pageImages"]:
        raise ValueError("Result does not contain the complete ordered page set")
    if any(not isinstance(page.get("seconds"), (int, float)) or isinstance(page["seconds"], bool)
           or not math.isfinite(page["seconds"]) or page["seconds"] <= 0 for page in pages):
        raise ValueError("Result page timing is invalid")


def stop_own_child(process, evidence):
    """Use only this invocation's Popen handle; preserve shutdown failures."""
    attempts = evidence.setdefault("childTermination", {"confirmed": False, "attempts": []})
    for action in ("terminate", "kill"):
        try:
            if process.poll() is None:
                getattr(process, action)()
                attempts["attempts"].append({"action": action})
            process.wait(timeout=15)
            attempts["confirmed"] = process.poll() is not None
            if attempts["confirmed"]:
                return
        except BaseException as error:
            attempts["attempts"].append({"action": action, "error": str(error), "errorType": type(error).__name__})


def run_guarded(args, *, sample_resources=resources, popen=subprocess.Popen, sleep=time.sleep, monotonic=time.monotonic):
    """Dependencies are injectable for finite, standard-library-only synthetic checks."""
    if not re.fullmatch(r"[A-Za-z0-9-]+", args.label):
        raise ValueError("Use a simple unique run label")
    root = args.root.resolve(strict=True)
    result = root / "results" / (args.label + ".json")
    log = root / "logs" / (args.label + ".txt")
    monitor_file = root / "results" / (args.label + "-resource-monitor.json")
    if any(file.exists() for file in (result, log, monitor_file)):
        raise ValueError("Run evidence already exists; choose a fresh label")
    result.parent.mkdir(parents=True, exist_ok=True)
    log.parent.mkdir(parents=True, exist_ok=True)
    limits = {"minimumFreeRamMiB": 1536, "maximumTotalGpuUsedMiB": 6400,
              "maximumGpuTemperatureC": 85, "maximumStartupGpuUtilizationPercent": 70,
              "maximumSeconds": 1800, "requiredConsecutiveViolations": 2, "pollSeconds": 3}
    evidence = {"schemaVersion": 1, "kind": "isolated-ocr-resource-monitor", "label": args.label,
                "engine": args.engine, "device": args.device, "limits": limits, "samples": [],
                "status": "NOT_RUN", "accepted": False,
                "scope": "Sampled checks are not hard caps. GPU measurements include all device users. Utilization is a startup gate only.",
                "priority": "BELOW_NORMAL_PRIORITY_CLASS", "productionProcessesModified": False}
    process, started = None, None

    def over(sample):
        for key in ("freeRamMiB", "totalGpuUsedMiB", "gpuTemperatureC", "totalGpuUtilizationPercent"):
            value = sample.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                raise ValueError("Invalid resource observation: " + key)
        return (sample["freeRamMiB"] < limits["minimumFreeRamMiB"]
                or sample["totalGpuUsedMiB"] > limits["maximumTotalGpuUsedMiB"]
                or sample["gpuTemperatureC"] > limits["maximumGpuTemperatureC"])

    try:
        runner = Path(__file__).resolve().with_name("benchmark-gpu-ocr.py")
        files, bindings, truth, expected = freeze_inputs(root, runner)
        evidence.update({"inputs": bindings, "expected": expected})
        baseline = dict(sample_resources())
        baseline["elapsed"] = 0
        evidence["samples"].append(baseline)
        if over(baseline) or baseline["totalGpuUtilizationPercent"] > limits["maximumStartupGpuUtilizationPercent"]:
            evidence["reason"] = "Shared resource startup gate; no OCR process started"
        else:
            command = [str(args.python.resolve(strict=True)), "-B", str(runner),
                       "--truth", str(files["truth"]), "--review", str(files["review"]),
                       "--output", str(result), "--engine", args.engine, "--device", args.device,
                       "--cache", str(root / "models"), "--threads", "2", "--cooldown", "2"]
            environment = dict(os.environ)
            for variable in ("TEMP", "TMP", "HF_HOME", "XDG_CACHE_HOME"):
                folder = root / "cache" / variable.lower()
                folder.mkdir(parents=True, exist_ok=True)
                environment[variable] = str(folder)
            environment.update({"PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"})
            started = monotonic()
            with log.open("x", encoding="utf-8") as handle:
                process = popen(command, stdout=handle, stderr=subprocess.STDOUT, env=environment,
                                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
                evidence["childPid"] = process.pid
                violations = 0
                while process.poll() is None:
                    sleep(limits["pollSeconds"])
                    if process.poll() is not None:
                        break
                    sample = dict(sample_resources())
                    sample["elapsed"] = round(monotonic() - started, 3)
                    evidence["samples"].append(sample)
                    violations = violations + 1 if over(sample) else 0
                    if violations >= limits["requiredConsecutiveViolations"] or monotonic() - started > limits["maximumSeconds"]:
                        evidence["status"] = "ABORTED_OWN_PROCESS"
                        evidence["reason"] = "Sampled resource/time threshold reached; stopping only the spawned child"
                        stop_own_child(process, evidence)
                        break
                if evidence["status"] == "NOT_RUN":
                    evidence["status"] = "PROCESS_EXITED"
                evidence["exitCode"] = process.returncode
                evidence["seconds"] = round(monotonic() - started, 3)
            if evidence["status"] == "PROCESS_EXITED" and evidence["exitCode"] == 0:
                for role, file in files.items():
                    if digest(file) != bindings[role]["sha256"]:
                        raise ValueError("Input changed during run: " + role)
                validate_completed_result(load_json(result), args, bindings, truth, expected)
                evidence["resultValidated"] = True
    except BaseException as error:
        evidence["status"] = "MONITOR_ERROR"
        evidence["reason"], evidence["errorType"] = str(error), type(error).__name__
        if process is not None:
            stop_own_child(process, evidence)
    finally:
        for role, file in (("result", result), ("log", log)):
            if file.exists():
                try:
                    evidence[role] = {"path": file.relative_to(root).as_posix(), "sha256": digest(file)}
                except BaseException as error:
                    evidence.setdefault("evidenceErrors", []).append({"role": role, "error": str(error)})
        evidence["accepted"] = (evidence["status"] == "PROCESS_EXITED" and evidence.get("exitCode") == 0
                                and evidence.get("resultValidated") is True and "result" in evidence and "log" in evidence
                                and not evidence.get("evidenceErrors"))
        with monitor_file.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(evidence, handle, indent=2)
            handle.write("\n")
    print(json.dumps({"label": args.label, "status": evidence["status"], "exitCode": evidence.get("exitCode"),
                      "accepted": evidence["accepted"], "monitor": str(monitor_file)}), flush=True)
    return 0 if evidence["accepted"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--engine", choices=["v5-mobile", "v5-server", "v6-small", "v6-medium"], required=True)
    parser.add_argument("--device", choices=["cpu", "gpu:0"], required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--label", required=True)
    return run_guarded(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
