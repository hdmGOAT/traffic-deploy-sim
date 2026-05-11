from pathlib import Path
import json

PROJECT_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = Path(__file__).resolve().parent / "model_registry.json"


def load_registry() -> dict:
    if not REGISTRY_PATH.exists():
        return {"models": []}
    return json.loads(REGISTRY_PATH.read_text())


def get_model_by_id(model_id: str) -> dict | None:
    registry = load_registry()
    for model in registry.get("models", []):
        if model.get("id") == model_id:
            resolved = dict(model)
            path_value = resolved.get("path")
            if isinstance(path_value, str):
                path = Path(path_value)
                if not path.is_absolute():
                    path = PROJECT_ROOT / path
                resolved["path"] = str(path.resolve())
            return resolved
    return None
