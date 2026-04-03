// KCode - Fine-tuning Runner
// Orchestrates fine-tuning of local models using LoRA/QLoRA via Unsloth or llama.cpp

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { log } from "../logger";

// ─── Types ──────────────────────────────────────────────────────

export interface FineTuneConfig {
  baseModel: string;
  trainingDataPath: string;
  outputDir: string;
  method: "lora" | "qlora" | "full";
  epochs: number;
  learningRate: number;
  loraRank: number;
}

export interface FineTuneResult {
  success: boolean;
  adapterPath?: string;
  duration: number; // milliseconds
  error?: string;
}

export interface ValidationResult {
  ready: boolean;
  issues: string[];
}

// ─── Constants ──────────────────────────────────────────────────

const MIN_TRAINING_PAIRS = 100;

// ─── FineTuner Class ────────────────────────────────────────────

export class FineTuner {
  /**
   * Validate that all prerequisites are met for fine-tuning.
   * Checks: Python availability, training data existence/size, GPU presence.
   */
  async validate(config: FineTuneConfig): Promise<ValidationResult> {
    const issues: string[] = [];

    // Check Python
    const pythonAvailable = await this.checkPython();
    if (!pythonAvailable) {
      issues.push("Python 3 is not installed or not in PATH. Install Python 3.10+ to proceed.");
    }

    // Check training data file exists
    if (!existsSync(config.trainingDataPath)) {
      issues.push(`Training data not found: ${config.trainingDataPath}`);
    } else {
      // Check minimum number of training pairs
      const pairCount = this.countJsonlLines(config.trainingDataPath);
      if (pairCount < MIN_TRAINING_PAIRS) {
        issues.push(
          `Insufficient training data: ${pairCount} pairs found, minimum ${MIN_TRAINING_PAIRS} required.`,
        );
      }
    }

    // Check GPU (nvidia-smi for NVIDIA, or macOS for Apple Silicon)
    const hasGpu = await this.checkGpu();
    if (!hasGpu) {
      issues.push("No GPU detected. Fine-tuning requires a GPU (NVIDIA CUDA or Apple Silicon).");
    }

    // Check base model path if it looks like a local path (starts with / or ./)
    if (
      (config.baseModel.startsWith("/") ||
        config.baseModel.startsWith("./") ||
        config.baseModel.startsWith("../")) &&
      !config.baseModel.startsWith("http")
    ) {
      if (!existsSync(config.baseModel)) {
        issues.push(`Base model not found: ${config.baseModel}`);
      }
    }

    // Validate config values
    if (config.epochs < 1 || config.epochs > 100) {
      issues.push(`Epochs must be between 1 and 100, got ${config.epochs}.`);
    }
    if (config.learningRate <= 0 || config.learningRate > 1) {
      issues.push(`Learning rate must be between 0 and 1, got ${config.learningRate}.`);
    }
    if (config.method === "lora" || config.method === "qlora") {
      if (config.loraRank < 4 || config.loraRank > 256) {
        issues.push(`LoRA rank must be between 4 and 256, got ${config.loraRank}.`);
      }
    }

    return {
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * Generate a Python training script for the given config.
   * Supports Unsloth (LoRA/QLoRA) and llama.cpp native fine-tuning.
   */
  generateTrainingScript(config: FineTuneConfig): string {
    if (config.method === "full") {
      return this.generateLlamaCppScript(config);
    }
    return this.generateUnslothScript(config);
  }

  /**
   * Execute the fine-tuning process as a subprocess.
   * Generates the training script, writes it to outputDir, then runs it with Python.
   */
  async run(config: FineTuneConfig, onProgress?: (msg: string) => void): Promise<FineTuneResult> {
    const startTime = Date.now();

    // Validate first
    const validation = await this.validate(config);
    if (!validation.ready) {
      return {
        success: false,
        duration: Date.now() - startTime,
        error: `Validation failed:\n${validation.issues.join("\n")}`,
      };
    }

    // Generate and write training script
    mkdirSync(config.outputDir, { recursive: true });
    const scriptPath = join(config.outputDir, "train.py");
    const script = this.generateTrainingScript(config);
    writeFileSync(scriptPath, script, "utf-8");
    onProgress?.(`Training script written to ${scriptPath}`);

    // Run training as subprocess
    try {
      onProgress?.("Starting fine-tuning process...");

      const proc = Bun.spawn(["python3", scriptPath], {
        cwd: config.outputDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      });

      // Stream stdout for progress updates
      if (onProgress) {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        const readStream = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              for (const line of text.split("\n").filter(Boolean)) {
                onProgress(line);
              }
            }
          } catch {
            /* stream ended */
          }
        };
        readStream(); // don't await — runs concurrently
      }

      const exitCode = await proc.exited;
      const duration = Date.now() - startTime;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return {
          success: false,
          duration,
          error: `Training process exited with code ${exitCode}:\n${stderr.slice(-2000)}`,
        };
      }

      // Determine adapter output path
      const adapterPath =
        config.method === "full"
          ? join(config.outputDir, "ggml-model-f16.gguf")
          : join(config.outputDir, "adapter");

      onProgress?.(`Fine-tuning complete in ${(duration / 1000).toFixed(1)}s`);

      return {
        success: true,
        adapterPath,
        duration,
      };
    } catch (err) {
      return {
        success: false,
        duration: Date.now() - startTime,
        error: `Failed to run training: ${err}`,
      };
    }
  }

  // ─── Private ────────────────────────────────────────────────

  private generateUnslothScript(config: FineTuneConfig): string {
    const quantMethod = config.method === "qlora" ? "4bit" : "none";
    const modelName = basename(config.baseModel);

    return `#!/usr/bin/env python3
"""
KCode Fine-tuning Script (Unsloth ${config.method.toUpperCase()})
Base model: ${config.baseModel}
Method: ${config.method} | Epochs: ${config.epochs} | LR: ${config.learningRate} | LoRA rank: ${config.loraRank}
Generated by KCode — do not edit manually.
"""

import sys
import json
import os

def check_deps():
    try:
        import unsloth
        import torch
        import datasets
    except ImportError as e:
        print(f"Missing dependency: {e}", file=sys.stderr)
        print("Install with: pip install unsloth torch datasets transformers", file=sys.stderr)
        sys.exit(1)

check_deps()

from unsloth import FastLanguageModel
from datasets import load_dataset
from transformers import TrainingArguments
from unsloth import UnslothTrainer

# ─── Configuration ───────────────────────────────────────────
BASE_MODEL = ${JSON.stringify(config.baseModel)}
TRAINING_DATA = ${JSON.stringify(config.trainingDataPath)}
OUTPUT_DIR = ${JSON.stringify(config.outputDir)}
EPOCHS = ${config.epochs}
LEARNING_RATE = ${config.learningRate}
LORA_RANK = ${config.loraRank}
QUANT = ${JSON.stringify(quantMethod)}

print(f"Loading model: {BASE_MODEL}")
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=BASE_MODEL,
    max_seq_length=4096,
    load_in_4bit=(QUANT == "4bit"),
)

print(f"Applying LoRA (rank={LORA_RANK})")
model = FastLanguageModel.get_peft_model(
    model,
    r=LORA_RANK,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"],
    lora_alpha=LORA_RANK * 2,
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
)

print(f"Loading training data: {TRAINING_DATA}")
dataset = load_dataset("json", data_files=TRAINING_DATA, split="train")

def format_chat(example):
    messages = example.get("messages", [])
    text = ""
    for msg in messages:
        role = msg["role"]
        content = msg["content"]
        if role == "user":
            text += f"<|user|>\\n{content}\\n"
        elif role == "assistant":
            text += f"<|assistant|>\\n{content}\\n"
    return {"text": text + tokenizer.eos_token}

dataset = dataset.map(format_chat)

training_args = TrainingArguments(
    output_dir=os.path.join(OUTPUT_DIR, "checkpoints"),
    num_train_epochs=EPOCHS,
    per_device_train_batch_size=2,
    gradient_accumulation_steps=4,
    learning_rate=LEARNING_RATE,
    logging_steps=10,
    save_strategy="epoch",
    fp16=True,
    optim="adamw_8bit",
    warmup_ratio=0.05,
    lr_scheduler_type="cosine",
    seed=42,
    report_to="none",
)

print("Starting training...")
trainer = UnslothTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=training_args,
)

trainer.train()

adapter_path = os.path.join(OUTPUT_DIR, "adapter")
print(f"Saving adapter to: {adapter_path}")
model.save_pretrained(adapter_path)
tokenizer.save_pretrained(adapter_path)

print(f"Training complete! Adapter saved to {adapter_path}")
print(f"Model: ${modelName} | Method: ${config.method} | Epochs: ${config.epochs}")
`;
  }

  private generateLlamaCppScript(config: FineTuneConfig): string {
    return `#!/usr/bin/env python3
"""
KCode Fine-tuning Script (llama.cpp full fine-tune)
Base model: ${config.baseModel}
Method: full | Epochs: ${config.epochs} | LR: ${config.learningRate}
Generated by KCode — do not edit manually.
"""

import sys
import subprocess
import os
import json

TRAINING_DATA = ${JSON.stringify(config.trainingDataPath)}
BASE_MODEL = ${JSON.stringify(config.baseModel)}
OUTPUT_DIR = ${JSON.stringify(config.outputDir)}
EPOCHS = ${config.epochs}
LEARNING_RATE = ${config.learningRate}

# Convert JSONL to plain text format for llama.cpp
print("Preparing training data...")
train_txt = os.path.join(OUTPUT_DIR, "train.txt")
with open(TRAINING_DATA, "r") as f_in, open(train_txt, "w") as f_out:
    for line in f_in:
        try:
            entry = json.loads(line.strip())
            messages = entry.get("messages", [])
            for msg in messages:
                role = msg["role"]
                content = msg["content"]
                f_out.write(f"<|{role}|>\\n{content}\\n")
            f_out.write("\\n")
        except json.JSONDecodeError:
            continue

print(f"Training data prepared: {train_txt}")

# Attempt to find llama-finetune binary
finetune_bin = None
for path in ["llama-finetune", "llama.cpp/finetune", "/usr/local/bin/llama-finetune"]:
    try:
        result = subprocess.run([path, "--help"], capture_output=True, timeout=5)
        if result.returncode == 0 or result.returncode == 1:
            finetune_bin = path
            break
    except (FileNotFoundError, subprocess.TimeoutExpired):
        continue

if not finetune_bin:
    print("ERROR: llama-finetune binary not found.", file=sys.stderr)
    print("Build llama.cpp with: make finetune", file=sys.stderr)
    sys.exit(1)

output_model = os.path.join(OUTPUT_DIR, "ggml-model-f16.gguf")

cmd = [
    finetune_bin,
    "--model", BASE_MODEL,
    "--train-data", train_txt,
    "--save-every", "100",
    "--epochs", str(EPOCHS),
    "--adam-alpha", str(LEARNING_RATE),
    "--ctx", "4096",
    "--batch", "4",
    "--checkpoint-out", os.path.join(OUTPUT_DIR, "checkpoint.gguf"),
    "--model-out", output_model,
]

print(f"Running: {' '.join(cmd)}")
result = subprocess.run(cmd, cwd=OUTPUT_DIR)

if result.returncode != 0:
    print(f"Fine-tuning failed with exit code {result.returncode}", file=sys.stderr)
    sys.exit(result.returncode)

print(f"Fine-tuning complete! Model saved to {output_model}")
`;
  }

  private async checkPython(): Promise<boolean> {
    try {
      const result = Bun.spawnSync(["python3", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async checkGpu(): Promise<boolean> {
    // Check NVIDIA
    try {
      const result = Bun.spawnSync(["nvidia-smi"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode === 0) return true;
    } catch {
      /* no nvidia-smi */
    }

    // Check Apple Silicon
    if (process.platform === "darwin" && process.arch === "arm64") {
      return true;
    }

    return false;
  }

  private countJsonlLines(filePath: string): number {
    try {
      const { readFileSync } = require("node:fs");
      const content = readFileSync(filePath, "utf-8") as string;
      return content.trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }
}
