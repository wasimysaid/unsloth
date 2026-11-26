// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export const followUpControls = {
  "./follow-ups": { FollowUpMenu: () => null, PendingFollowUps: () => null },
  "./use-follow-up-delivery": {
    FOLLOW_UP_DELIVERIES: {
      queue: { action: "Queue message" },
      steer: { action: "Steer the running work" },
    },
    useFollowUpDelivery: () => ({
      delivery: "queue", opposite: "steer", choose() {}, shortcut: "Ctrl+Enter", hint: "",
    }),
  },
};
