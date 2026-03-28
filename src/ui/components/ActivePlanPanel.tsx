import React from "react";
import { Box, Text } from "ink";
import type { Plan } from "../../tools/plan.js";
import { useTheme } from "../ThemeContext.js";

interface ActivePlanPanelProps {
  plan: Plan | null;
}

export default function ActivePlanPanel({ plan }: ActivePlanPanelProps) {
  const { theme } = useTheme();

  if (!plan) return null;

  const statusIcons: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    done: "[x]",
    skipped: "[-]",
  };

  const statusColors: Record<string, string> = {
    pending: theme.dimmed,
    in_progress: theme.warning,
    done: theme.success,
    skipped: theme.dimmed,
  };

  const done = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const barLen = 20;
  const filled = total > 0 ? Math.round((done / total) * barLen) : 0;
  const bar = "=".repeat(filled) + " ".repeat(barLen - filled);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2}>
      <Text bold color={theme.primary}>{plan.title} ({done}/{total} - {pct}%)</Text>
      <Text color={theme.dimmed}>  [{bar}]</Text>
      {plan.steps.map((step, i) => (
        <Text key={`active-plan-step-${i}`} color={statusColors[step.status] ?? theme.dimmed}>
          {"  "}{statusIcons[step.status] ?? "[ ]"} {step.id}. {step.title}
        </Text>
      ))}
    </Box>
  );
}
