"""Download the pinned multilingual Laya checkpoint during first-use setup."""
import json
from pathlib import Path
import shutil
import sys

from huggingface_hub import snapshot_download

MODEL_REPOSITORY = "convaiinnovations/laya-multilingual"
MODEL_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"

destination = Path(sys.argv[1])
snapshot_download(
    MODEL_REPOSITORY,
    revision=MODEL_REVISION,
    local_dir=destination,
    allow_patterns=["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"],
)
# Normalize once during setup; inference must not mutate the model directory.
config_file = destination / "tokenizer/tokenizer_config.json"
config = json.loads(config_file.read_text())
if config.get("tokenizer_class") in (None, "TokenizersBackend"):
    config["tokenizer_class"] = "PreTrainedTokenizerFast"
    config.pop("backend", None)
    config.pop("is_local", None)
if isinstance(config.get("extra_special_tokens"), list):
    config["extra_special_tokens"] = {
        f"extra_{i}": token for i, token in enumerate(config["extra_special_tokens"])
    }
config_file.write_text(json.dumps(config, indent=2) + "\n")
(destination / "provenance.json").write_text(json.dumps({
    "repository": MODEL_REPOSITORY, "revision": MODEL_REVISION, "laya_version": "0.3.27",
}) + "\n")
shutil.rmtree(destination / ".cache", ignore_errors=True)
