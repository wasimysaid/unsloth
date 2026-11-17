# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Validated launch settings shared by model presets and explicit model loads."""

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

from picker.schemas import MAX_CHAT_TEMPLATE_BYTES, chat_template_byte_length
from utils.reasoning_budget import validate_reasoning_budget_message
from utils.openai_auto_switch_settings import (
    BATCH_SIZE_MAX, BATCH_SIZE_MIN, CACHE_RAM_MAX_MIB, CACHE_RAM_MIN_MIB,
    CTX_CHECKPOINTS_MAX, MAX_GPU_ID, PARALLEL_SLOTS_MAX, PARALLEL_SLOTS_MIN,
)

MAX_GPU_IDS = MAX_GPU_ID + 1


class ModelLoadConfig(BaseModel):
    """Per-model launch settings shared by saved presets and explicit loads."""

    model_config = ConfigDict(extra = "forbid")

    engine_parallelism: Optional[Literal["tensor", "pipeline", "data"]] = None
    engine_precision: Optional[Literal["auto", "bf16", "fp16", "int4", "int8", "fp8"]] = None
    engine: Optional[Literal["auto", "vllm", "sglang"]] = None
    engine_kv_cache_dtype: Optional[Literal["auto", "fp8"]] = None
    engine_seed: Optional[int] = Field(default = None, ge = 0, le = 2**31 - 1)
    engine_gpu_memory_utilization: Optional[float] = Field(default = None, ge = 0.05, le = 0.99)
    # Saved presets preserve omitted flags; an explicit load supplies [] to clear them.
    llama_extra_args: Optional[list[str]] = None
    # ge=1: the setter drops a falsy value, so reject 0 here instead of discarding it silently.
    max_seq_length: Optional[int] = Field(default = None, ge = 1, le = 1048576)
    custom_context_length: Optional[int] = Field(default = None, ge = 1, le = 1048576)
    kv_cache_dtype: Optional[str] = Field(default = None, max_length = 32)
    # A discrete set, enforced by the normalizer; these bounds only block absurd values.
    mlx_kv_quant: Optional[str] = Field(default = None, max_length = 16)
    mlx_kv_bits: Optional[float] = Field(default = None, ge = 2, le = 8)

    @model_validator(mode = "after")
    def derive_mlx_kv_quant(self):
        """Fold the pair into the field storage keeps; null is how a client spells Auto."""

        if "mlx_kv_quant" not in self.model_fields_set and self.mlx_kv_bits is not None:
            from core.inference.mlx_inference import encode_mlx_kv_quant
            self.mlx_kv_quant = encode_mlx_kv_quant(self.mlx_kv_bits)
        self.mlx_kv_bits = None
        return self

    speculative_type: Optional[str] = Field(default = None, max_length = 32)
    spec_draft_n_max: Optional[int] = Field(default = None, ge = 1, le = 16)
    spec_draft_model: Optional[str] = Field(default = None, max_length = 1024)
    # Parallel decode slots (llama-server --parallel), GGUF-only; None follows the server default.
    n_parallel: Optional[int] = Field(default = None, ge = PARALLEL_SLOTS_MIN, le = PARALLEL_SLOTS_MAX)
    reasoning_budget: Optional[int] = Field(default = None, ge = -1, le = 2_147_483_647)
    reasoning_budget_message: Optional[str] = None
    # prompt batch sizes (--batch-size / --ubatch-size), gguf-only; none = llama.cpp defaults
    n_batch: Optional[int] = Field(default = None, ge = BATCH_SIZE_MIN, le = BATCH_SIZE_MAX)
    n_ubatch: Optional[int] = Field(default = None, ge = BATCH_SIZE_MIN, le = BATCH_SIZE_MAX)
    # model_override_load_kwargs applies all four from a stored row; dropping them strands the setting.
    load_mode: Optional[str] = Field(default = None, max_length = 32)
    spec_draft_cache_type: Optional[str] = Field(default = None, max_length = 32)
    # Stored on "is not None": 0 and -1 are meaningful. Bounds mirror LoadRequest.
    ctx_checkpoints: Optional[int] = Field(default = None, ge = 0, le = CTX_CHECKPOINTS_MAX)
    cache_ram: Optional[int] = Field(default = None, ge = CACHE_RAM_MIN_MIB, le = CACHE_RAM_MAX_MIB)
    engram_precision: Optional[str] = Field(default = None, max_length = 32, pattern = r"^[A-Za-z0-9_]*$")
    tensor_parallel: bool = False
    disable_vision: bool = False
    mlx_int8_prefill: bool = False
    mlx_ane_prefill: bool = False
    mlx_fast_verify: bool = False
    npu_power_mode: Optional[
        Literal["default", "powersaver", "balanced", "performance", "turbo"]
    ] = None
    npu_prefill_chunk_len: Optional[StrictInt] = Field(default = None, ge = 1, le = 1048576)
    npu_img_pre_resize: Optional[StrictInt] = Field(default = None, ge = 0, le = 4)
    # Auto (null or "auto") is stored as absence; omitted keeps the stored value.
    mlx_ple_offload: Optional[Union[Literal["auto", "off"], float]] = None
    mlx_expert_offload: Optional[Union[Literal["auto", "off"], float]] = None

    @field_validator("mlx_ple_offload", "mlx_expert_offload", mode = "before")
    @classmethod
    def _mlx_offload_amount(cls, value: Any) -> Any:
        from models.inference import _mlx_offload_amount
        return _mlx_offload_amount(value)

    # Default-engine 16-bit load; only False is stored.
    load_in_4bit: bool = True
    # Validated in bytes below: pydantic counts characters, so a multi-byte template would pass.
    chat_template_override: Optional[str] = None
    gpu_memory_mode: Optional[Literal["auto", "manual"]] = None
    # -1 is Auto (llama.cpp --fit sizes the offload); the normalizer treats it as unset.
    gpu_layers: Optional[int] = Field(default = None, ge = -1, le = 2**31 - 1)
    n_cpu_moe: Optional[int] = Field(default = None, ge = 0, le = 1024)
    tensor_split: Optional[list[float]] = Field(default = None, min_length = 2, max_length = MAX_GPU_IDS)
    gpu_ids: Optional[list[int]] = Field(default = None, max_length = MAX_GPU_IDS)
    # Which index space gpu_ids is in. Absent means physical, the only thing a client
    # written before this field could have meant.
    gpu_index_kind: Optional[Literal["physical", "vulkan", "cuda_device"]] = None

    @model_validator(mode = "after")
    def _tensor_split_matches_gpu_ids(self):
        if self.tensor_split is not None:
            from utils.openai_auto_switch_settings import normalize_tensor_split
            if normalize_tensor_split(self.tensor_split, self.gpu_ids) is None:
                raise ValueError(
                    "tensor_split must match an ordered selection of at least two unique GPUs"
                )
        return self

    @field_validator("tensor_split")
    @classmethod
    def _valid_tensor_split(cls, value: Optional[list[float]]) -> Optional[list[float]]:
        if value is None:
            return None
        from utils.openai_auto_switch_settings import normalize_tensor_split

        if normalize_tensor_split(value, list(range(len(value)))) is None:
            raise ValueError("tensor_split must be finite, non-negative, and have a positive total")
        return value

    @field_validator("chat_template_override")
    @classmethod
    def _limit_chat_template_bytes(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        size = chat_template_byte_length(value)
        if size is None:
            raise ValueError("Chat template contains unpaired surrogate characters.")
        if size > MAX_CHAT_TEMPLATE_BYTES:
            raise ValueError(f"Chat template exceeds the {MAX_CHAT_TEMPLATE_BYTES}-byte limit.")
        return value

    @field_validator("reasoning_budget_message")
    @classmethod
    def _validate_reasoning_budget_message(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else validate_reasoning_budget_message(value)

    @field_validator(
        "max_seq_length",
        "custom_context_length",
        "spec_draft_n_max",
        "n_parallel",
        "reasoning_budget",
        "n_batch",
        "n_ubatch",
        "ctx_checkpoints",
        "cache_ram",
        "gpu_layers",
        "n_cpu_moe",
        "gpu_ids",
        "tensor_split",
        mode = "before",
    )
    @classmethod
    def _no_booleans(cls, value: Any) -> Any:
        # bool subclasses int and pydantic parses non-strictly.
        if isinstance(value, bool):
            raise ValueError("Expected a number, got a boolean.")
        if isinstance(value, list) and any(isinstance(item, bool) for item in value):
            raise ValueError("Expected numbers, got a boolean.")
        return value

