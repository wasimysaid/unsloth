// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  composerShortcutLabels,
  useChatPreferencesStore,
} from "@/features/chat";
import { isMacPlatform } from "@/features/settings";
import {
  CornerDownRightIcon,
  ListEndIcon,
  type LucideIcon,
} from "lucide-react";
import type { FollowUpDelivery } from "./input";

export const FOLLOW_UP_DELIVERIES: Record<
  FollowUpDelivery,
  {
    label: string;
    action: string;
    description: string;
    pending: string;
    icon: LucideIcon;
  }
> = {
  queue: {
    label: "Queue",
    action: "Queue message",
    description: "Send after the current work finishes",
    pending: "Queued",
    icon: ListEndIcon,
  },
  steer: {
    label: "Steer",
    action: "Steer the running work",
    description: "Redirect the running work at its next step",
    pending: "Steering",
    icon: CornerDownRightIcon,
  },
};

/** New Chat's follow-up preference, so both surfaces deliver alike. */
export function useFollowUpDelivery() {
  const delivery = useChatPreferencesStore((s) => s.followUpBehavior);
  const choose = useChatPreferencesStore((s) => s.setFollowUpBehavior);
  const opposite: FollowUpDelivery = delivery === "queue" ? "steer" : "queue";
  const keys = composerShortcutLabels("enter", isMacPlatform());
  return {
    delivery,
    opposite,
    choose,
    shortcut: keys.opposite,
    hint: `${FOLLOW_UP_DELIVERIES[delivery].action} (${keys.send}) · ${keys.opposite} to ${FOLLOW_UP_DELIVERIES[opposite].label.toLowerCase()} instead`,
  };
}
