# SPDX-License-Identifier: AGPL-3.0-only
"""Downloaded inventory projection, not a model-serving acceptance substitute."""
from types import SimpleNamespace

import pytest

from core.coding_local_models import local_catalog, local_choice, resolve_local_choice
from core.coding_runtime import CodingRuntimeError


def row(identity="semantic-a", **changes):
    values = dict(inventory_id=identity, id="wire-a", load_id="/models/a.gguf",
                  display_name="Same label", partial=False, model_format="gguf", format_variant=None,
                  capabilities=SimpleNamespace(can_chat=True))
    values.update(changes)
    return SimpleNamespace(**values)


@pytest.mark.asyncio
async def test_catalog_reuses_current_downloaded_inventory_and_exact_identity(monkeypatch):
    from hub.services.models import local_inventory
    rows = [row(), row("semantic-b", id="wire-b", load_id="/models/b.gguf"),
            row("partial", partial=True),
            row("encoder", capabilities=SimpleNamespace(can_chat=False))]

    async def inventory():
        return SimpleNamespace(models=rows)

    monkeypatch.setattr(local_inventory, "list_local_models_response", inventory)
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
    with pytest.raises(CodingRuntimeError, match="no model was substituted"):
        await resolve_local_choice(a["id"])


def test_identity_survives_label_changes_and_never_encodes_credentials():
    choice = local_choice(row())
    assert choice["id"] == local_choice(row(display_name="renamed"))["id"]
    assert set(choice) == {"id", "name", "api_model", "reasoning", "default_reasoning"}
    assert choice["reasoning"] == "unsupported"
    assert choice["default_reasoning"] is None


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
    with pytest.raises(CodingRuntimeError, match="No fallback"):
        await serving.acquire({**request, "operation_id": "forged-op", "api_model": "different"}, None)
    assert len(launches) == 1
