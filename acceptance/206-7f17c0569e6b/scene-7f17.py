"""Pinned three-way real Chromium dock geometry for #206: main, superseded candidate and final head.

Covers dock geometry at 1280/720, the 20px UI-font scaled rest inset, and the
first-ever docked drag that moves away and returns to its start X before release.
Only the monitor's persisted open preference is seeded; every position below is
produced by real pointer input or by the app's own restore logic.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

WORKSPACE = Path(os.environ.get("UNSLOTH_WORKSPACE", "/home/mugi/unsloth-workbench/skills/pr-ui-evidence"))
sys.path.insert(0, str(WORKSPACE))
sys.path.insert(0, str(WORKSPACE / "scripts"))
from studio_test_kit.auth import seed_init_script  # noqa: E402
from studio_test_kit.ui import open_chat  # noqa: E402

OPEN = "Open run settings"
CLOSE = "Close run settings"

MEASURE = """() => {
  const monitor = document.querySelector('[data-testid="floating-monitor"]');
  const container = monitor?.parentElement || null;
  const panel = document.querySelector('[data-slot="chat-settings-panel"]');
  const grip = document.querySelector('[data-testid="floating-monitor-drag-handle"]');
  const handle = panel?.querySelector('[data-slot="panel-resize-handle"]') || null;
  const bounds = el => {if (!el) return null; const r=el.getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const root = getComputedStyle(document.documentElement);
  const m = monitor?.getBoundingClientRect();
  const c = container?.getBoundingClientRect();
  const p = panel?.getBoundingClientRect();
  return {
    innerWidth, innerHeight,
    monitor: bounds(monitor), panel: bounds(panel), grip: bounds(grip), resizeHandle: bounds(handle),
    monitorVisible: visible(monitor), panelVisible: visible(panel), gripVisible: visible(grip),
    ariaHidden: container?.getAttribute('aria-hidden') || null,
    monitorStyle: monitor?.getAttribute('style') || null,
    containerStyle: container?.getAttribute('style') || null,
    containerRight: container ? getComputedStyle(container).right : null,
    panelStyle: panel?.getAttribute('style') || null,
    monitorOffsetInContainer: m && c ? {left: +(m.left - c.left).toFixed(3), top: +(m.top - c.top).toFixed(3)} : null,
    uiSpaceScale: root.getPropertyValue('--ui-space-scale').trim(),
    uiFontScale: root.getPropertyValue('--ui-font-scale').trim(),
    uiFontAttribute: document.documentElement.getAttribute('data-ui-font-size'),
    overlap: m && p ? +Math.max(0, Math.min(m.right, p.right) - Math.max(m.left, p.left)).toFixed(3) : null,
  };
}"""


async def drive(session, out_dir: Path, label: str, **kwargs):
    auth = type("Auth", (), {"access_token": session.access_token, "refresh_token": session.refresh_token})()
    init = seed_init_script(auth, [])
    opening = "localStorage.setItem('unsloth_monitor_overlay', JSON.stringify({state:{isOpen:true,isMinimized:false},version:0}));"
    artifacts = []
    facts = {"label": label, "states": {}, "drags": {}, "viewport": [1280, 800]}
    async with open_chat(session.base_url, init_scripts=[init, opening], viewport=(1280, 800), headless=True) as sp:
        page = sp.page
        await page.get_by_role("button", name=OPEN).wait_for(timeout=60000)
        await page.get_by_test_id("floating-monitor").wait_for(state="visible", timeout=30000)

        async def record(name: str):
            await page.wait_for_timeout(500)
            facts["states"][name] = await page.evaluate(MEASURE)
            shot = out_dir / f"{name}.png"
            await page.screenshot(path=str(shot), full_page=False)
            artifacts.append(shot)

        async def panel_width():
            return await page.evaluate("""() => {
              const p = document.querySelector('[data-slot=\"chat-settings-panel\"]');
              return p ? p.getBoundingClientRect().width : 0;
            }""")

        async def open_panel():
            await page.get_by_role("button", name=OPEN).click()
            for _ in range(120):
                if await panel_width() > 0:
                    return
                await page.wait_for_timeout(250)
            raise RuntimeError("run settings panel never widened")

        async def close_panel():
            # The aside stays mounted at w-0 after closing, so visibility, not
            # detachment, is what marks the docked constraint going away.
            await page.get_by_role("button", name=CLOSE).click()
            for _ in range(120):
                if await panel_width() <= 0.5:
                    await page.wait_for_timeout(600)
                    return
                await page.wait_for_timeout(250)
            raise RuntimeError("run settings panel never collapsed")
        async def drag_away_and_back(tag: str, dx: int = -60, dy: int = 0):
            """Press the grip, move away, return to the exact start, release there."""
            grip = page.get_by_test_id("floating-monitor-drag-handle")
            box = await grip.bounding_box()
            if not box:
                raise RuntimeError("drag handle has no box")
            x = box["x"] + box["width"] / 2
            y = box["y"] + box["height"] / 2
            await page.mouse.move(x, y)
            await page.mouse.down()
            await page.mouse.move(x + dx, y + dy, steps=8)
            await record(f"{tag}-away-held")
            await page.mouse.move(x, y, steps=8)
            await record(f"{tag}-back-held")
            await page.mouse.up()
            await record(f"{tag}-released")
            facts["drags"][tag] = {"start": [x, y], "away": [x + dx, y + dy]}

        # 1. Resting anchors and the docked/narrow layout at the default UI font.
        await record("wide-closed")
        await open_panel()
        await record("wide-open")
        await page.set_viewport_size({"width": 720, "height": 800})
        await record("narrow-open")
        await page.set_viewport_size({"width": 1280, "height": 800})
        await record("wide-restored")

        # 2. First-ever drag: docked, away and back to the start X, released there.
        # A release at the start must leave the monitor anchored, so undocking
        # returns it to the right rest anchor.
        await drag_away_and_back("netzero")
        await close_panel()
        await record("netzero-undocked")

        # 3. A saved full-width X must survive a later docked net-zero drag.
        await drag_away_and_back("savedx-fullwidth", dx=-120)
        await open_panel()
        await record("savedx-docked")
        await drag_away_and_back("savedx-docked")
        await close_panel()
        await record("savedx-undocked")

        # 4. The supported 20px maximum UI font: scaled rest inset and the same
        # net-zero docked drag at the scaled geometry.
        await page.evaluate("""() => localStorage.setItem(
          'unsloth_appearance_customization',
          JSON.stringify({state:{customization:{uiFontSize:20}},version:7})
        )""")
        await page.reload(wait_until="domcontentloaded")
        await page.get_by_role("button", name=OPEN).wait_for(timeout=60000)
        await page.get_by_test_id("floating-monitor").wait_for(state="visible", timeout=30000)
        await record("font20-closed")
        await open_panel()
        await record("font20-open")
        await drag_away_and_back("font20-netzero")
        await close_panel()
        await record("font20-undocked")
        facts["final_properties"] = await page.evaluate("""() => ({
          uiSpaceScale: getComputedStyle(document.documentElement).getPropertyValue('--ui-space-scale').trim(),
          uiFontScale: getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale').trim(),
          uiFontAttribute: document.documentElement.getAttribute('data-ui-font-size')
        })""")
        facts["browser_cleanup"] = "open_chat context-manager closes browser"
    return artifacts, facts
