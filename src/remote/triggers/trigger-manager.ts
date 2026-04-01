// KCode - Remote Trigger Manager

import type { TriggerApiClient } from "./trigger-api";
import type {
  RemoteTrigger,
  TriggerCreateInput,
  TriggerRunResult,
  TriggerUpdateInput,
} from "./types";
import { TriggerValidationError } from "./types";

/**
 * Validates a 5-field cron expression: "min hour dom month dow".
 * Accepts: numbers, *, ranges (1-5), steps (asterisk/5), lists (1,3,5).
 * Throws TriggerValidationError on invalid input.
 */
export function validateCron(expression: string): void {
  if (!expression || typeof expression !== "string") {
    throw new TriggerValidationError("Cron expression must be a non-empty string");
  }

  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/);

  if (fields.length !== 5) {
    throw new TriggerValidationError(
      `Cron expression must have exactly 5 fields (min hour dom month dow), got ${fields.length}`,
    );
  }

  const fieldDefs: { name: string; min: number; max: number }[] = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day of month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12 },
    { name: "day of week", min: 0, max: 7 },
  ];

  for (let i = 0; i < 5; i++) {
    validateCronField(fields[i], fieldDefs[i].name, fieldDefs[i].min, fieldDefs[i].max);
  }
}

function validateCronField(field: string, name: string, min: number, max: number): void {
  // Split by comma for lists: "1,3,5"
  const parts = field.split(",");

  for (const part of parts) {
    if (part === "") {
      throw new TriggerValidationError(`Invalid ${name} field: empty value in list`);
    }

    // Check for step: "*/5" or "1-10/2"
    const stepParts = part.split("/");
    if (stepParts.length > 2) {
      throw new TriggerValidationError(
        `Invalid ${name} field: "${part}" has multiple step operators`,
      );
    }

    const base = stepParts[0];
    const step = stepParts[1];

    // Validate step value
    if (step !== undefined) {
      const stepNum = Number(step);
      if (!Number.isInteger(stepNum) || stepNum < 1) {
        throw new TriggerValidationError(
          `Invalid ${name} field: step value "${step}" must be a positive integer`,
        );
      }
    }

    // Validate base: "*" or range "1-5" or single number
    if (base === "*") {
      continue;
    }

    // Check for range: "1-5"
    const rangeParts = base.split("-");
    if (rangeParts.length > 2) {
      throw new TriggerValidationError(
        `Invalid ${name} field: "${base}" has multiple range operators`,
      );
    }

    for (const val of rangeParts) {
      const num = Number(val);
      if (!Number.isInteger(num)) {
        throw new TriggerValidationError(`Invalid ${name} field: "${val}" is not a valid integer`);
      }
      if (num < min || num > max) {
        throw new TriggerValidationError(
          `Invalid ${name} field: ${num} is out of range (${min}-${max})`,
        );
      }
    }

    // Validate range order
    if (rangeParts.length === 2) {
      const start = Number(rangeParts[0]);
      const end = Number(rangeParts[1]);
      if (start > end) {
        throw new TriggerValidationError(
          `Invalid ${name} field: range start ${start} is greater than end ${end}`,
        );
      }
    }
  }
}

/**
 * Business logic layer for managing remote triggers.
 * Delegates persistence to TriggerApiClient and adds validation.
 */
export class TriggerManager {
  private api: TriggerApiClient;

  constructor(api: TriggerApiClient) {
    this.api = api;
  }

  /**
   * Create a new trigger with cron validation.
   */
  async create(input: TriggerCreateInput): Promise<RemoteTrigger> {
    if (!input.name || input.name.trim().length === 0) {
      throw new TriggerValidationError("Trigger name is required");
    }
    if (!input.prompt || input.prompt.trim().length === 0) {
      throw new TriggerValidationError("Trigger prompt is required");
    }

    validateCron(input.schedule);

    if (input.maxTurns !== undefined && (input.maxTurns < 1 || input.maxTurns > 100)) {
      throw new TriggerValidationError("maxTurns must be between 1 and 100");
    }

    return this.api.createTrigger(input);
  }

  /**
   * List all triggers.
   */
  async list(): Promise<RemoteTrigger[]> {
    return this.api.listTriggers();
  }

  /**
   * Get a single trigger by ID.
   */
  async get(id: string): Promise<RemoteTrigger | null> {
    return this.api.getTrigger(id);
  }

  /**
   * Update a trigger. Validates cron if schedule is being changed.
   */
  async update(id: string, updates: TriggerUpdateInput): Promise<RemoteTrigger> {
    if (updates.schedule !== undefined) {
      validateCron(updates.schedule);
    }

    if (updates.name !== undefined && updates.name.trim().length === 0) {
      throw new TriggerValidationError("Trigger name cannot be empty");
    }

    if (updates.maxTurns !== undefined && (updates.maxTurns < 1 || updates.maxTurns > 100)) {
      throw new TriggerValidationError("maxTurns must be between 1 and 100");
    }

    return this.api.updateTrigger(id, updates);
  }

  /**
   * Delete a trigger by ID.
   */
  async delete(id: string): Promise<void> {
    return this.api.deleteTrigger(id);
  }

  /**
   * Pause an active trigger.
   */
  async pause(id: string): Promise<void> {
    await this.api.updateTrigger(id, { status: "paused" });
  }

  /**
   * Resume a paused trigger.
   */
  async resume(id: string): Promise<void> {
    await this.api.updateTrigger(id, { status: "active" });
  }

  /**
   * Manually run a trigger immediately.
   */
  async runNow(id: string): Promise<TriggerRunResult> {
    return this.api.runTrigger(id);
  }

  /**
   * Get execution history for a trigger.
   */
  async getHistory(id: string, limit?: number): Promise<TriggerRunResult[]> {
    return this.api.getTriggerHistory(id, limit);
  }
}
