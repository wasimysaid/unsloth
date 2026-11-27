// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { SkillsManager, useSkillsCatalog } from "@/features/chat";
import { useT } from "@/i18n";
import { useMemo } from "react";
import { skillCodingReach, summarizeCodingReach } from "../coding-agent/coding-reach";
import { CodingReachLine, SettingsPageHeader } from "../coding-agent/coding-reach-view";

/**
 * Studio's skill library as Coding sees it. Coding has no switch of its own, so each row's Chat
 * switch says it all; an Invalid or Shadowed skill already says why nothing loads it.
 */
export function CodingSkillsTab() {
  const t = useT();
  const { skills, initialized } = useSkillsCatalog();
  const summary = useMemo(() => summarizeCodingReach(skills.map(skillCodingReach)), [skills]);

  return (
    <div className="settings-page">
      <SettingsPageHeader
        title={t("settings.codingAgent.skills.title")}
        description={t("settings.codingAgent.skills.description")}
      />
      <SkillsManager
        active={true}
        layout="page"
        intro={<CodingReachLine summary={summary} ready={initialized} />}
        enabledLabel={t("settings.codingAgent.skills.enabledLabel")}
      />
    </div>
  );
}
