# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Inventory the application router compositions even when exports are lazy."""

import routes

from .inventory import collect_routes


def test_lazy_exports_keep_parent_authentication_in_inventory(monkeypatch):
    # A fresh coding/auth import does not populate the full application's exports.
    # The inventory must resolve those compositions itself, not select a bare
    # child router that omits its parent's authentication/account dependencies.
    for name in routes.__all__:
        monkeypatch.delitem(vars(routes), name, raising = False)

    cases = {case.key: case for case in collect_routes()}
    analysis = cases["routes.data_recipe.jobs:GET:/jobs/{job_id}/analysis"]
    assert analysis.router is routes.data_recipe_router
    assert "routes.rag:GET:/jobs/{job_id}/events" in cases
