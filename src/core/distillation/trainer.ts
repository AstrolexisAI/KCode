// KCode - Fine-Tuning Trainer for Model Distillation
// Generates and launches training scripts for various backends
// (Unsloth, Axolotl, LLaMA-Factory, MLX-LM).

import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { log } from "../logger";
import { kcodePath } from "../paths";
import type { TrainingConfig, TrainingHandle, TrainingBackend } from "./types";

// ─── Defaults ──────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = kcodePath("models", "finetuned");
const SUPPORTED_BACKENDS: TrainingBackend[] = [
  "unsloth",
  "axolotl",
  "llamafactory",
  "mlx-lm",
];

// ─── ModelTrainer ──────────────────────────────────────────────

export class ModelTrainer {
  /**
   * Build a complete TrainingConfig with defaults applied.
   */
  static defaults(partial?: Partial<TrainingConfig>): TrainingConfig {
    return {
      backend: partial?.backend ?? "unsloth",
      baseModel:
        partial?.baseModel ?? "unsloth/Qwen2.5-Coder-7B-Instruct",
      datasetPath: partial?.datasetPath ?? "",
      outputDir: partial?.outputDir ?? DEFAULT_OUTPUT_DIR,
      epochs: partial?.epochs ?? 3,
      batchSize: partial?.batchSize ?? 4,
      learningRate: partial?.learningRate ?? 2e-5,
      loraRank: partial?.loraRank ?? 16,
      loraAlpha: partial?.loraAlpha ?? 32,
      maxSeqLength: partial?.maxSeqLength ?? 4096,
      quantization: partial?.quantization ?? "4bit",
      cudaDevices: partial?.cudaDevices ?? "0",
    };
  }

  /**
   * Validate a training configuration before launch.
   */
  validateConfig(config: TrainingConfig): string[] {
    const errors: string[] = [];

    if (!SUPPORTED_BACKENDS.includes(config.backend)) {
      errors.push(
        `Unsupported backend: "${config.backend}". Supported: ${SUPPORTED_BACKENDS.join(", ")}`,
      );
    }

    if (!config.baseModel) {
      errors.push("baseModel is required");
    }

    if (!config.datasetPath) {
      errors.push("datasetPath is required");
    } else if (!existsSync(config.datasetPath)) {
      errors.push(`Dataset file not found: ${config.datasetPath}`);
    }

    if (config.epochs < 1 || config.epochs > 100) {
      errors.push(`epochs must be between 1 and 100 (got ${config.epochs})`);
    }

    if (config.batchSize < 1 || config.batchSize > 256) {
      errors.push(
        `batchSize must be between 1 and 256 (got ${config.batchSize})`,
      );
    }

    if (config.learningRate <= 0 || config.learningRate > 1) {
      errors.push(
        `learningRate must be between 0 and 1 (got ${config.learningRate})`,
      );
    }

    if (config.loraRank < 4 || config.loraRank > 256) {
      errors.push(
        `loraRank must be between 4 and 256 (got ${config.loraRank})`,
      );
    }

    if (config.maxSeqLength < 256 || config.maxSeqLength > 131072) {
      errors.push(
        `maxSeqLength must be between 256 and 131072 (got ${config.maxSeqLength})`,
      );
    }

    return errors;
  }

  /**
   * Launch a fine-tuning training job. Writes the training script to disk
   * and spawns it as a background process.
   */
  async train(config: TrainingConfig): Promise<TrainingHandle> {
    const errors = this.validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid training config:\n  - ${errors.join("\n  - ")}`);
    }

    // Ensure output directory exists
    mkdirSync(config.outputDir, { recursive: true });

    // Generate the training script
    const script = this.generateTrainingScript(config);
    const scriptPath = join(config.outputDir, "train.py");
    await Bun.write(scriptPath, script);

    const logFile = join(config.outputDir, "train.log");
    const errFile = join(config.outputDir, "train.err");

    log.info(
      "distill",
      `Launching ${config.backend} training: ${config.baseModel} with ${config.datasetPath}`,
    );

    // Spawn the training process in the background
    const proc = Bun.spawn(["python3", scriptPath], {
      cwd: config.outputDir,
      stdout: Bun.file(logFile),
      stderr: Bun.file(errFile),
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: config.cudaDevices ?? "0",
      },
    });

    return {
      pid: proc.pid,
      logFile,
      outputDir: config.outputDir,
      status: "running",
    };
  }

  /**
   * Check the status of a training job by reading its log file.
   */
  checkStatus(handle: TrainingHandle): TrainingHandle {
    const logFile = handle.logFile;
    if (!existsSync(logFile)) {
      return { ...handle, status: "running" };
    }

    try {
      const content = readFileSync(logFile, "utf-8");
      if (content.includes("TRAINING_COMPLETE")) {
        return { ...handle, status: "completed" };
      }
      if (content.includes("TRAINING_FAILED") || content.includes("Error")) {
        // Only if the last line indicates failure
        const lastLines = content.trim().split("\n").slice(-5).join("\n");
        if (
          lastLines.includes("TRAINING_FAILED") ||
          lastLines.includes("Traceback")
        ) {
          return { ...handle, status: "failed" };
        }
      }
    } catch {
      // Can't read log — assume still running
    }

    return { ...handle, status: "running" };
  }

  // ─── Script Generation ─────────────────────────────────────────

  /**
   * Generate the Python training script for the specified backend.
   */
  generateTrainingScript(config: TrainingConfig): string {
    switch (config.backend) {
      case "unsloth":
        return this.generateUnslothScript(config);
      case "mlx-lm":
        return this.generateMLXScript(config);
      case "axolotl":
        return this.generateAxolotlScript(config);
      case "llamafactory":
        return this.generateLlamaFactoryScript(config);
      default:
        throw new Error(`Backend "${config.backend}" is not implemented`);
    }
  }

  /**
   * Generate an Unsloth training script.
   * Uses FastLanguageModel + SFTTrainer with LoRA adapters.
   * Exports to GGUF for llama.cpp deployment.
   */
  private generateUnslothScript(config: TrainingConfig): string {
    const load4bit = config.quantization === "4bit" ? "True" : "False";
    return `#!/usr/bin/env python3
# KCode Model Distillation — Unsloth Training Script
# Auto-generated. Do not edit manually.

import sys
try:
    from unsloth import FastLanguageModel
    from trl import SFTTrainer
    from transformers import TrainingArguments
    from datasets import load_dataset
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Install with: pip install unsloth trl transformers datasets", file=sys.stderr)
    print("TRAINING_FAILED")
    sys.exit(1)

print("Loading base model: ${config.baseModel}")
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="${config.baseModel}",
    max_seq_length=${config.maxSeqLength},
    load_in_4bit=${load4bit},
)

print("Applying LoRA adapters (r=${config.loraRank}, alpha=${config.loraAlpha})")
model = FastLanguageModel.get_peft_model(
    model,
    r=${config.loraRank},
    lora_alpha=${config.loraAlpha},
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"],
)

print("Loading dataset: ${config.datasetPath}")
dataset = load_dataset("json", data_files="${config.datasetPath}", split="train")
print(f"Dataset size: {len(dataset)} examples")

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=TrainingArguments(
        per_device_train_batch_size=${config.batchSize},
        num_train_epochs=${config.epochs},
        learning_rate=${config.learningRate},
        output_dir="${config.outputDir}/checkpoints",
        logging_steps=10,
        save_strategy="epoch",
        fp16=True,
        gradient_accumulation_steps=4,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
    ),
)

print("Starting training...")
trainer.train()

print("Exporting to GGUF...")
model.save_pretrained_gguf(
    "${config.outputDir}/gguf",
    tokenizer,
    quantization_method="q4_k_m",
)

print("TRAINING_COMPLETE")
`;
  }

  /**
   * Generate an MLX-LM training script (for macOS Apple Silicon).
   */
  private generateMLXScript(config: TrainingConfig): string {
    return `#!/usr/bin/env python3
# KCode Model Distillation — MLX-LM Training Script
# Auto-generated. Do not edit manually.

import sys
try:
    import mlx
    from mlx_lm import load, generate
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Install with: pip install mlx-lm", file=sys.stderr)
    print("TRAINING_FAILED")
    sys.exit(1)

import subprocess
import json

print("Starting MLX-LM fine-tuning: ${config.baseModel}")

# MLX-LM uses a YAML config + CLI for fine-tuning
config = {
    "model": "${config.baseModel}",
    "data": "${config.datasetPath}",
    "batch_size": ${config.batchSize},
    "num_epochs": ${config.epochs},
    "learning_rate": ${config.learningRate},
    "lora_layers": ${config.loraRank},
    "adapter_path": "${config.outputDir}/adapters",
    "max_seq_length": ${config.maxSeqLength},
}

config_path = "${config.outputDir}/mlx_config.json"
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)

result = subprocess.run(
    ["python3", "-m", "mlx_lm.lora",
     "--model", "${config.baseModel}",
     "--data", "${config.datasetPath}",
     "--batch-size", str(${config.batchSize}),
     "--num-layers", str(${config.loraRank}),
     "--adapter-path", "${config.outputDir}/adapters",
     "--iters", str(${config.epochs} * 1000),
     "--learning-rate", str(${config.learningRate}),
    ],
    capture_output=True,
    text=True,
)

if result.returncode != 0:
    print(f"MLX-LM training failed:\\n{result.stderr}", file=sys.stderr)
    print("TRAINING_FAILED")
    sys.exit(1)

print(result.stdout)
print("TRAINING_COMPLETE")
`;
  }

  /**
   * Generate an Axolotl training config/script.
   */
  private generateAxolotlScript(config: TrainingConfig): string {
    return `#!/usr/bin/env python3
# KCode Model Distillation — Axolotl Training Script
# Auto-generated. Do not edit manually.

import sys
import yaml
import subprocess

axolotl_config = {
    "base_model": "${config.baseModel}",
    "model_type": "AutoModelForCausalLM",
    "tokenizer_type": "AutoTokenizer",
    "load_in_4bit": ${config.quantization === "4bit" ? "True" : "False"},
    "datasets": [{
        "path": "${config.datasetPath}",
        "type": "sharegpt",
    }],
    "output_dir": "${config.outputDir}/checkpoints",
    "sequence_len": ${config.maxSeqLength},
    "micro_batch_size": ${config.batchSize},
    "num_epochs": ${config.epochs},
    "learning_rate": ${config.learningRate},
    "adapter": "lora",
    "lora_r": ${config.loraRank},
    "lora_alpha": ${config.loraAlpha},
    "lora_target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
}

config_path = "${config.outputDir}/axolotl_config.yml"
with open(config_path, "w") as f:
    yaml.dump(axolotl_config, f)

print(f"Axolotl config written to {config_path}")
print("Starting Axolotl training...")

result = subprocess.run(
    ["python3", "-m", "axolotl.cli.train", config_path],
    capture_output=True,
    text=True,
)

if result.returncode != 0:
    print(f"Axolotl training failed:\\n{result.stderr}", file=sys.stderr)
    print("TRAINING_FAILED")
    sys.exit(1)

print(result.stdout)
print("TRAINING_COMPLETE")
`;
  }

  /**
   * Generate a LLaMA-Factory training script.
   */
  private generateLlamaFactoryScript(config: TrainingConfig): string {
    return `#!/usr/bin/env python3
# KCode Model Distillation — LLaMA-Factory Training Script
# Auto-generated. Do not edit manually.

import sys
import json
import subprocess

llama_factory_args = {
    "stage": "sft",
    "model_name_or_path": "${config.baseModel}",
    "dataset_dir": "${config.datasetPath}",
    "output_dir": "${config.outputDir}/checkpoints",
    "per_device_train_batch_size": ${config.batchSize},
    "num_train_epochs": ${config.epochs},
    "learning_rate": ${config.learningRate},
    "finetuning_type": "lora",
    "lora_rank": ${config.loraRank},
    "lora_alpha": ${config.loraAlpha},
    "cutoff_len": ${config.maxSeqLength},
    "quantization_bit": ${config.quantization === "4bit" ? 4 : config.quantization === "8bit" ? 8 : 0},
}

config_path = "${config.outputDir}/llama_factory_config.json"
with open(config_path, "w") as f:
    json.dump(llama_factory_args, f, indent=2)

print(f"LLaMA-Factory config written to {config_path}")
print("Starting LLaMA-Factory training...")

result = subprocess.run(
    ["python3", "-m", "llamafactory.cli", "train", config_path],
    capture_output=True,
    text=True,
)

if result.returncode != 0:
    print(f"LLaMA-Factory training failed:\\n{result.stderr}", file=sys.stderr)
    print("TRAINING_FAILED")
    sys.exit(1)

print(result.stdout)
print("TRAINING_COMPLETE")
`;
  }
}
