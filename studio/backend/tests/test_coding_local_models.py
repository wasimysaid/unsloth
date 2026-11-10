# SPDX-License-Identifier: AGPL-3.0-only
"""Downloaded inventory projection, not a model-serving acceptance substitute."""
from types import SimpleNamespace

import pytest

from core.coding_local_models import local_catalog, local_choice, resolve_local_choice
from core.coding_runtime import CodingRuntimeError


def row(identity="semantic-a", **changes):
    values = dict(inventory_id=identity, id="wire-a", load_id="/models/a.gguf", source="custom",
                  display_name="Same label", partial=False, model_format="gguf", format_variant=None,
                  capabilities=SimpleNamespace(can_chat=True))
    values.update(changes)
    return SimpleNamespace(**values)


def cached_gguf(monkeypatch, repos=(), variants=None):
    from hub.services.models import cache_inventory, gguf_variants

    async def cached():
        return {"cached": list(repos), "scan_confirmed": True}

    async def listing(repo_id, prefer_local_cache, offline, include_cache_locations):
        assert prefer_local_cache and offline and include_cache_locations
        return SimpleNamespace(response=SimpleNamespace(variants=(variants or {})[repo_id]),
                               context_source=None, variant_context_sources=None)

    monkeypatch.setattr(cache_inventory, "list_cached_gguf_response", cached)
    monkeypatch.setattr(gguf_variants, "get_gguf_variants_answer", listing)


def inventory(monkeypatch, rows):
    from hub.services.models import local_inventory

    async def response():
        return SimpleNamespace(models=rows)

    monkeypatch.setattr(local_inventory, "list_local_models_response", response)


@pytest.mark.asyncio
async def test_catalog_lists_each_downloaded_quant_like_on_device(monkeypatch):
    def repo(repo_id, **changes):
        # list_cached_gguf_response returns plain dict rows.
        values = dict(repo_id=repo_id, load_id=repo_id, inventory_id=None, capabilities={"can_chat": True})
        values.update(changes)
        return values

    def quant(name, **changes):
        values = dict(quant=name, display_label=None, downloaded=True, partial=False)
        values.update(changes)
        return SimpleNamespace(**values)

    cached_gguf(monkeypatch, [repo("org/Split-27B-GGUF"), repo("org/Speech-GGUF", capabilities={"can_chat": False})], {
        "org/Split-27B-GGUF": [quant("BF16"), quant("UD-Q4_K_XL", partial=True), quant("Q8_0", downloaded=False)],
    })
    # The inventory's own row for a cached GGUF repo has no exact quant and may call a
    # complete split download "unknown"; the per-quant rows replace it.
    inventory(monkeypatch, [row(id="org/Split-27B-GGUF", source="hf_cache", model_format="unknown",
                                capabilities=SimpleNamespace(can_chat=False), partial=True),
                            row("custom", id="/models/custom.gguf", load_id="/models/custom.gguf")])
    models = (await local_catalog())["models"]
    assert [model["name"] for model in models] == ["Split-27B-GGUF · BF16", "Same label"]
    assert models[0]["api_model"] == "org/Split-27B-GGUF:BF16"
    selected = await resolve_local_choice(models[0]["id"])
    assert (selected.load_id, selected.format_variant) == ("org/Split-27B-GGUF", "BF16")


@pytest.mark.asyncio
async def test_catalog_reuses_current_downloaded_inventory_and_exact_identity(monkeypatch):
    rows = [row(), row("semantic-b", id="wire-b", load_id="/models/b.gguf"),
            row("partial", partial=True),
            row("encoder", capabilities=SimpleNamespace(can_chat=False))]
    cached_gguf(monkeypatch)
    inventory(monkeypatch, rows)
    catalog = await local_catalog()
    assert catalog["id"] == "studio-local"
    assert len(catalog["models"]) == 2
    a, b = catalog["models"]
    assert a["id"] != b["id"]
    assert a["name"] == b["name"]
    assert a["api_model"] == "/models/a.gguf"
    assert await resolve_local_choice(a["id"]) is rows[0]
    rows.pop(0)
    assert (await local_catalog())["models"] == [b]
    with pytest.raises(CodingRuntimeError) as missing:
        await resolve_local_choice(a["id"])
    assert missing.value.code == "unavailable"


def test_identity_survives_label_changes_and_never_encodes_credentials():
    choice = local_choice(row())
    assert choice["id"] == local_choice(row(display_name="renamed"))["id"]
    assert set(choice) == {"id", "name", "api_model", "reasoning"}
    assert choice["reasoning"] == {"thinking": False, "toggle": False, "levels": []}


def test_api_mapping_preserves_exact_repository_variant_but_not_duplicate_file_suffix():
    assert local_choice(row(load_id="org/repo", format_variant="Q4_K_M"))["api_model"] == "org/repo:Q4_K_M"
    assert local_choice(row(format_variant="Q4_K_M"))["api_model"] == "/models/a.gguf"


@pytest.mark.asyncio
async def test_native_admission_reuses_studio_launch_preferences_without_force_or_wrong_mapping(monkeypatch):
    from core.coding_local_models import CodingLocalServing
    from routes import inference
    from utils import openai_auto_switch_settings as settings
    selected = row(load_id="org/repo", format_variant="Q4_K_M")
    choice = local_choice(selected)
    launches = []

    async def resolve(identifier):
        assert identifier == choice["id"]
        return selected

    async def admit(request, _http_request, subject, token):
        launches.append(request)
        assert subject == "unsloth"
        assert token == "exact-op"

    monkeypatch.setattr("core.coding_local_models.resolve_local_choice", resolve)
    monkeypatch.setattr(inference, "load_model_for_coding", admit)
    monkeypatch.setattr(settings, "resolve_override_for_load", lambda target, _alias, variant: (target, {"max_seq_length": 32768}))
    serving = CodingLocalServing("incarnation", "private-key", "unsloth")
    request = dict(incarnation="incarnation", operation_id="exact-op", conversation_id="session",
                   request_id="request", model_id=choice["id"], api_model=choice["api_model"])
    result = await serving.acquire(request, None)
    assert result["api_model"] == "org/repo:Q4_K_M"
    assert len(launches) == 1
    launch = launches[0]
    assert launch.model_path == "org/repo"
    assert launch.gguf_variant == "Q4_K_M"
    assert launch.max_seq_length == 32768
    assert not launch.force_cancel_active
    assert not launch.force_reload
    assert not launch.alongside
    assert not launch.force_alongside
    await serving.acquire(request, None)
    assert len(launches) == 1
    with pytest.raises(CodingRuntimeError, match="identity"):
        await serving.acquire({**request, "api_model": "different"}, None)
    with pytest.raises(CodingRuntimeError) as changed:
        await serving.acquire({**request, "operation_id": "forged-op", "api_model": "different"}, None)
    assert changed.value.code == "conflict"
    assert len(launches) == 1


@pytest.mark.parametrize("template, expected", [
    ("{% if enable_thinking %}<think>{% endif %}", {"thinking": True, "toggle": True, "levels": []}),
    ("{{ reasoning_effort }} {% if reasoning_effort == 'low' %}{% elif reasoning_effort == 'high' %}{% endif %}",
     {"thinking": True, "toggle": False, "levels": ["low", "high"]}),
    ("<think>{{ content }}</think>", {"thinking": True, "toggle": False, "levels": []}),
    ("{{ messages }}", {"thinking": False, "toggle": False, "levels": []}),
])
def test_reasoning_controls_follow_studio_template_detection(monkeypatch, tmp_path, template, expected):
    from core import coding_local_models
    from utils.models import gguf_metadata
    path = tmp_path / "model.gguf"
    path.write_bytes(b"GGUF")
    coding_local_models._template_reasoning.cache_clear()
    monkeypatch.setattr(gguf_metadata, "read_gguf_chat_template", lambda read: template if read == str(path) else None)
    controls = coding_local_models.reasoning_controls(str(path), "org/model")
    assert {**controls, "levels": [level for level in controls["levels"] if level in ("low", "high")]} == expected
    assert coding_local_models.reasoning_controls(str(tmp_path / "missing.gguf"), "org/model")["thinking"] is False


def test_load_errors_say_why_without_host_paths():
    from fastapi import HTTPException
    from core.coding_local_models import _load_error
    busy = _load_error(HTTPException(409, detail={"error": "coding_model_busy",
                                                  "message": "Studio is loading another model. Retry when it finishes."}))
    assert (busy.code, busy.message) == ("busy", "Studio is loading another model. Retry when it finishes.")
    failed = _load_error(HTTPException(500, detail="Not enough GPU memory for /home/someone/.cache/huggingface/hub/x.gguf"))
    assert failed.code == "failed" and "Not enough GPU memory" in failed.message
    assert "/home/someone" not in failed.message
    unknown = _load_error(RuntimeError("secret token sk-abc at /home/someone"))
    assert unknown.code == "failed" and "sk-abc" not in unknown.message and "/home" not in unknown.message
