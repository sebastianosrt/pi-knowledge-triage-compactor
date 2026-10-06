"""Classify a bounded instruction batch using an installed Laya checkpoint on CPU."""
import contextlib
import json
import os
from pathlib import Path
import sys

# Set these before importing Laya/transformers, including when invoked directly.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["USE_TF"] = "0"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ.setdefault("USER", "laya")
os.environ.setdefault("TORCHINDUCTOR_CACHE_DIR", f"/tmp/pi-triage-laya-{os.getuid()}/torch")

QUESTIONS = {
    "knowledge_type": {
        "type": "choice",
        "instructions": "Classify this agent knowledge item by its operational role.",
        "criteria": {
            "constraint": "A rule or fact whose omission risks a safety or correctness failure.",
            "procedural": "A step to accomplish work.",
            "belief": "A factual assertion about the world.",
            "preference": "A soft preference.",
            "episodic": "A record of an event.",
        },
    },
    "safety_critical": {
        "type": "noul",
        "instructions": "Could omitting this item cause an unsafe or incorrect agent action?",
        "criteria": {"true": "Yes, it is a safety or correctness boundary.", "false": "No."},
    },
}


def main():
    model_directory = Path(sys.argv[1])
    if not model_directory.is_absolute() or not model_directory.is_dir():
        raise ValueError("Laya requires an existing absolute local model directory")
    raw = sys.stdin.buffer.read(65_537)
    if len(raw) > 65_536:
        raise ValueError("Laya input exceeds 64 KiB")
    texts = json.loads(raw)["texts"]
    if not isinstance(texts, list) or not 1 <= len(texts) <= 16:
        raise ValueError("Laya requires between one and sixteen instructions")
    if any(not isinstance(text, str) or not 1 <= len(text) <= 500 for text in texts):
        raise ValueError("Laya instructions must be nonempty strings of at most 500 characters")

    # Keep upstream diagnostics out of the JSON transport.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from laya import Agent

        torch.set_num_threads(4)
        agent = Agent(str(model_directory), device="cpu", compile=False)
        results = agent.predict_batch(texts, QUESTIONS, batch_size=4, max_len=1024)
    json.dump({"results": results}, sys.stdout, ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
