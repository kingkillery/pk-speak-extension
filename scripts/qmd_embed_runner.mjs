#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(),
    command: process.env.LLM_WIKI_QMD_COMMAND || null,
    stateFile: null,
    skipUpdate: false,
    skipText: false,
    includeImages: false,
    collection: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--workspace":
        options.workspace = argv[++i];
        break;
      case "--command":
        options.command = argv[++i];
        break;
      case "--state-file":
        options.stateFile = argv[++i];
        break;
      case "--collection":
        options.collection = argv[++i];
        break;
      case "--skip-update":
        options.skipUpdate = true;
        break;
      case "--skip-text":
        options.skipText = true;
        break;
      case "--include-images":
        options.includeImages = true;
        break;
      case "--help":
        console.log(`qmd_embed_runner

Usage:
  node scripts/qmd_embed_runner.mjs [options]

Options:
  --workspace <path>      Workspace root to operate in (default: current directory)
  --command <name>        QMD command to use (default: config or LLM_WIKI_QMD_COMMAND or pk-qmd)
  --state-file <path>     JSON state output path (default: .llm-wiki/qmd-embed-state.json)
  --collection <name>     Collection name to record in the state snapshot
  --skip-update           Skip 'pk-qmd update'
  --skip-text             Skip 'pk-qmd embed'
  --include-images        Also run 'pk-qmd membed' when GEMINI_API_KEY is set
  --help                  Show this help
`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.stateFile) {
    options.stateFile = path.join(options.workspace, ".llm-wiki", "qmd-embed-state.json");
  }

  return options;
}

function loadConfig(workspace) {
  const configPath = path.join(workspace, ".llm-wiki", "config.json");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function resolveWorkspacePath(workspace, candidate) {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.join(workspace, candidate);
}

function resolveQmdCommand(options, config) {
  if (options.command) {
    return options.command;
  }

  const sourceCheckout = resolveWorkspacePath(options.workspace, config?.pk_qmd?.source_checkout_path);
  if (sourceCheckout) {
    for (const candidate of [
      path.join(sourceCheckout, "dist", "cli", "qmd.js"),
      path.join(sourceCheckout, "bin", "qmd.cmd"),
      path.join(sourceCheckout, "bin", "qmd.ps1"),
      path.join(sourceCheckout, "bin", "qmd"),
      path.join(sourceCheckout, "bin", "pk-qmd.cmd"),
      path.join(sourceCheckout, "bin", "pk-qmd.ps1"),
      path.join(sourceCheckout, "bin", "pk-qmd"),
    ]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const localCandidates = Array.isArray(config?.pk_qmd?.local_command_candidates)
    ? config.pk_qmd.local_command_candidates
    : [];
  for (const candidate of localCandidates) {
    const resolved = resolveWorkspacePath(options.workspace, candidate);
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  const configured = config?.pk_qmd?.command;
  if (typeof configured === "string" && configured.trim()) {
    const resolved = resolveWorkspacePath(options.workspace, configured.trim());
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
    return configured.trim();
  }

  return "pk-qmd";
}

function writeState(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function resolveQmdConfigDir(workspace, config) {
  const configured = config?.pk_qmd?.config_dir;
  const resolved = resolveWorkspacePath(workspace, typeof configured === "string" ? configured : ".llm-wiki/qmd-config");
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function runCommand(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.workspace);
  const qmdCommand = resolveQmdCommand(options, config);
  const qmdConfigDir = resolveQmdConfigDir(options.workspace, config);
  const qmdEnv = { QMD_CONFIG_DIR: qmdConfigDir };
  const startedAt = new Date().toISOString();

  writeState(options.stateFile, {
    status: "running",
    startedAt,
    workspace: options.workspace,
    command: qmdCommand,
    collection: options.collection,
    configDir: qmdConfigDir,
    includeImages: options.includeImages,
  });

  try {
    if (!options.skipUpdate) {
      runCommand(qmdCommand, ["update"], options.workspace, qmdEnv);
    }

    if (!options.skipText) {
      runCommand(qmdCommand, ["embed"], options.workspace, qmdEnv);
    }

    if (options.includeImages && process.env.GEMINI_API_KEY) {
      runCommand(qmdCommand, ["membed"], options.workspace, qmdEnv);
    }

    writeState(options.stateFile, {
      status: "ok",
      finishedAt: new Date().toISOString(),
      workspace: options.workspace,
      command: qmdCommand,
      collection: options.collection,
      configDir: qmdConfigDir,
      includeImages: options.includeImages,
    });
  } catch (error) {
    writeState(options.stateFile, {
      status: "error",
      finishedAt: new Date().toISOString(),
      workspace: options.workspace,
      command: qmdCommand,
      collection: options.collection,
      configDir: qmdConfigDir,
      includeImages: options.includeImages,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

main();
