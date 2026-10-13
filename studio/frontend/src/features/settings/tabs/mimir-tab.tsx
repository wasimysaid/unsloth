// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import {
  codingApi,
  codingMaintenanceApi,
  readCodingDiagnostics,
} from "@/features/coding/api";
import {
  type RuntimeDiagnostics,
  createMaintenanceInspection,
} from "@/features/coding/maintenance";
import type { CodingConversation } from "@/features/coding/types";
import { useT } from "@/i18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SettingsSection } from "../components/settings-section";
import { useSettingsDialogStore } from "../stores/settings-dialog-store";

// One bounded Settings projection per browser lifetime. Unresolved transport IDs
// survive modal/tab remounts; this holds no native resource or execution handle.
const inspection = createMaintenanceInspection(codingMaintenanceApi);

export function MimirTab() {
  const t = useT();
  const requested = useSettingsDialogStore(
    (state) => state.mimirConversationRequested,
  );
  const state = useSyncExternalStore(
    inspection.subscribe,
    inspection.getSnapshot,
  );
  const [conversations, setConversations] = useState<CodingConversation[]>([]);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(
    null,
  );
  const [diagnosticError, setDiagnosticError] = useState(false);
  const [listError, setListError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const refreshingRef = useRef(false);
  const refreshView = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    await Promise.all([
      codingApi
        .listConversations()
        .then((items) => {
          if (mounted.current) {
            setConversations(items.filter((item) => item.live));
            setListError(false);
          }
        })
        .catch(() => {
          if (mounted.current) setListError(true);
        }),
      readCodingDiagnostics()
        .then((value) => {
          if (mounted.current) {
            setDiagnostics(value);
            setDiagnosticError(false);
          }
        })
        .catch(() => {
          if (mounted.current) setDiagnosticError(true);
        }),
      inspection.refresh(),
    ]);
    refreshingRef.current = false;
    if (mounted.current) setRefreshing(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refreshView();
    return () => {
      mounted.current = false;
    };
  }, [refreshView]);
  useEffect(() => {
    // Null means the shared dialog has consumed/cleared its deep-open request,
    // not that the user cleared the target. Preserve inspection across remounts.
    if (requested) inspection.select(requested);
  }, [requested]);
  // Re-read only while a known operation needs reconciliation. This is not an
  // execution scheduler or automatic retry. Bound background reads to one minute.
  const native = state.inventory?.inventory;
  const reload = native?.reload;
  const pendingKey =
    state.target &&
    !state.submitting &&
    (state.uncertainOperation ||
      (reload && ["deferred", "reconciling"].includes(reload.status)
        ? reload.operation_id
        : null));
  useEffect(() => {
    if (!pendingKey) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (++attempts > 30) {
        window.clearInterval(timer);
        return;
      }
      void inspection.refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pendingKey]);
  const reloadDisabled =
    !state.target ||
    !state.inventory ||
    !!state.error ||
    state.loading ||
    state.submitting ||
    !!state.uncertainOperation ||
    ["deferred", "reconciling"].includes(reload?.status ?? "");
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="mimir-settings">
      <p className="text-sm text-muted-foreground">
        {t("mimirSettings.description")}
      </p>
      <div className="flex min-w-0 flex-col gap-2">
        <label
          htmlFor="mimir-settings-conversation"
          className="text-sm font-medium"
        >
          {t("mimirSettings.target")}
        </label>
        <select
          id="mimir-settings-conversation"
          value={state.target ?? ""}
          onChange={(event) => inspection.select(event.target.value || null)}
          className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{t("mimirSettings.choose")}</option>
          {state.target &&
            !conversations.some((item) => item.id === state.target) && (
              <option value={state.target}>{state.target}</option>
            )}
          {conversations.map((item) => (
            <option value={item.id} key={item.id}>
              {item.cwd} · {item.id}
            </option>
          ))}
        </select>
        {state.target && (
          <p
            className="break-all font-mono text-xs"
            data-testid="mimir-settings-target"
          >
            {state.target}
          </p>
        )}
        {!state.target && (
          <p className="text-xs text-muted-foreground">
            {t("mimirSettings.noTarget")}
          </p>
        )}
        {listError && (
          <p role="alert" className="text-sm">
            {t("mimirSettings.listError")}
          </p>
        )}
        <Button
          variant="outline"
          className="h-auto min-h-9 w-fit max-w-full whitespace-normal"
          disabled={refreshing || state.loading || state.submitting}
          onClick={() => void refreshView()}
        >
          {t("mimirSettings.refresh")}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t("mimirSettings.refreshScope")}
        </p>
        {state.loading && <output>{t("mimirSettings.loading")}</output>}
        {state.error && (
          <p role="alert" className="break-words text-sm">
            {t(`mimirSettings.${state.error}`)}
          </p>
        )}
      </div>
      <SettingsSection
        title={t("mimirSettings.plugins")}
        description={t("mimirSettings.pluginScope")}
      >
        <ul
          className="flex min-w-0 flex-col gap-3 py-2"
          aria-label={t("mimirSettings.plugins")}
        >
          {native?.plugins.map((plugin) => (
            <li
              key={`${plugin.id}:${plugin.lifetime}`}
              className="min-w-0 rounded-lg border border-border p-3 text-sm"
            >
              <p className="break-words font-medium">
                {plugin.name}{" "}
                <span className="font-mono text-xs">{plugin.version}</span>
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {plugin.id}
              </p>
              <p className="mt-1 break-words">
                {t(
                  plugin.installed
                    ? "mimirSettings.installed"
                    : "mimirSettings.notInstalled",
                )}{" "}
                ·{" "}
                {t(
                  plugin.selected
                    ? "mimirSettings.selected"
                    : "mimirSettings.unselected",
                )}{" "}
                ·{" "}
                {t(
                  plugin.enabled
                    ? "mimirSettings.enabled"
                    : "mimirSettings.disabled",
                )}{" "}
                ·{" "}
                {t(
                  (
                    plugin.lifetime === "runtime"
                      ? native.runtime_live_available
                      : native.session_live_available
                  )
                    ? plugin.live
                      ? "mimirSettings.live"
                      : "mimirSettings.notLive"
                    : "mimirSettings.unavailable",
                )}
              </p>
              {plugin.selected_frontend && (
                <p className="mt-1 text-xs">{t("mimirSettings.frontend")}</p>
              )}
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {plugin.lifetime}
              </p>
              {!plugin.eligible && (
                <p className="mt-1 text-xs">{t("mimirSettings.ineligible")}</p>
              )}
              {plugin.pending && (
                <p className="mt-1 text-xs">{t("mimirSettings.pending")}</p>
              )}
              {plugin.retained && (
                <p className="mt-1 text-xs">{t("mimirSettings.retained")}</p>
              )}
              {plugin.load_failed && (
                <p className="mt-1 text-xs">{t("mimirSettings.loadFailed")}</p>
              )}
              {plugin.runtime_failed && (
                <p className="mt-1 text-xs">
                  {t("mimirSettings.runtimeFailed")}
                </p>
              )}
              {plugin.missing_requirements.length > 0 && (
                <p className="mt-1 break-words text-xs">
                  {t("mimirSettings.missing", {
                    requirements: plugin.missing_requirements.join(", "),
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
        {native?.plugins.length === 0 && (
          <p className="py-2 text-sm">{t("mimirSettings.noPlugins")}</p>
        )}
        {!!native?.omitted_plugins && (
          <p className="py-2 text-sm">
            {t("mimirSettings.omittedPlugins", {
              count: native.omitted_plugins,
            })}
          </p>
        )}
        {native && (
          <p className="py-2 text-xs text-muted-foreground">
            {t("mimirSettings.nativeDiagnostics", native.diagnostics)}
          </p>
        )}
        <Button
          variant="outline"
          className="h-auto min-h-9 w-fit max-w-full whitespace-normal"
          disabled={reloadDisabled}
          onClick={() => void inspection.reload(crypto.randomUUID())}
        >
          {t(
            state.submitting
              ? "mimirSettings.reloadSending"
              : "mimirSettings.reload",
          )}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("mimirSettings.reloadScope")}
        </p>
        <output
          className="mt-2 block break-words text-sm"
          data-testid="mimir-plugin-reload-status"
          aria-live="polite"
        >
          {state.uncertainOperation
            ? t("mimirSettings.uncertain")
            : reload
              ? t(`mimirSettings.${reload.status}`, { changed: reload.changed })
              : null}
        </output>
      </SettingsSection>
      <SettingsSection
        title={t("mimirSettings.skills")}
        description={t("mimirSettings.skillScope")}
      >
        <ul className="py-2" aria-label={t("mimirSettings.skills")}>
          {state.inventory?.skills.map((skill) => (
            <li key={skill.name} className="break-words py-1 text-sm">
              {skill.name}
            </li>
          ))}
        </ul>
        {state.inventory?.skills.length === 0 && (
          <p className="text-sm">{t("mimirSettings.noSkills")}</p>
        )}
        {!!state.inventory?.omitted_skills && (
          <p className="py-2 text-sm">
            {t("mimirSettings.omittedSkills", {
              count: state.inventory.omitted_skills,
            })}
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        title={t("mimirSettings.diagnostics")}
        description={t("mimirSettings.diagnosticScope")}
      >
        {diagnosticError && (
          <p role="alert" className="text-sm">
            {t("mimirSettings.diagnosticError")}
          </p>
        )}
        {diagnostics && (
          <dl
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 text-sm"
            data-testid="mimir-runtime-diagnostics"
          >
            <dt>{t("mimirSettings.connection")}</dt>
            <dd className="break-words">{diagnostics.connection}</dd>
            <dt>Frontend</dt>
            <dd className="break-all">{diagnostics.frontend_plugin}</dd>
            <dt>{t("mimirSettings.protocol")}</dt>
            <dd>{diagnostics.protocol}</dd>
            <dt>{t("mimirSettings.commands")}</dt>
            <dd>{diagnostics.pending_commands}</dd>
            <dt>{t("mimirSettings.views")}</dt>
            <dd>{diagnostics.open_views}</dd>
            <dt>{t("mimirSettings.timeout")}</dt>
            <dd>{diagnostics.command_timeout_seconds}</dd>
            <dt>{t("mimirSettings.bound")}</dt>
            <dd>{diagnostics.max_frame_bytes}</dd>
          </dl>
        )}
      </SettingsSection>
      <SettingsSection title={t("mimirSettings.mcp")}>
        <p className="text-xs text-muted-foreground">
          {t("mimirSettings.otherScope")}
        </p>
      </SettingsSection>
    </div>
  );
}
