---
name: pokemon-benchmark
description: Use when the agent should bootstrap a neutral repo with llm_wiki_prompt_packet and launch the Gym-Anything Pokemon benchmark through the packet-owned wrapper surface. This skill handles the contract-first smoke run, the optional framework run, and the required machine-readable result reporting path.
---

# pokemon-benchmark

This is the packet-owned launcher skill for the repo-local Pokemon benchmark wrapper.

Use it to make a neutral repo benchmark-ready, then run the installed Pokemon benchmark commands from that neutral repo instead of from the source packet checkout.

This launcher skill is not itself the harness under test. The benchmarked harness or skill should be invoked with `pokemon-benchmark` available as the benchmark-side coordinator.

## Startup

1. Treat the current working directory as the neutral repo root unless deeper repo instructions say otherwise.
2. Check whether the neutral repo is already bootstrapped for this packet. Verify these paths first:
- `AGENTS.md`
- `.llm-wiki/config.json`
- `scripts/llm_wiki_packet.py`
- `scripts/run_pokemon_benchmark.ps1`
- `scripts/pokemon_benchmark_adapter.py`
- one repo-local skill surface such as `.codex/skills/pokemon-benchmark/SKILL.md`
3. If those paths are missing, bootstrap the neutral repo before attempting the benchmark.

## Bootstrap The Neutral Repo

### One-command hosted install (`--wire-repo`)

Preferred path. Downloads the latest release, installs the packet into the neutral repo, wires global Claude config, and runs the health check.

**PowerShell (Windows):**
```powershell
$f="$env:TEMP\llm-wiki-install.ps1"; iwr https://raw.githubusercontent.com/kingkillery/llm_wiki_prompt_packet/main/install.ps1 -OutFile $f; cd <neutral-repo>; & $f -WireRepo
```

**Shell (macOS / Linux):**
```bash
cd <neutral-repo> && curl -fsSL https://raw.githubusercontent.com/kingkillery/llm_wiki_prompt_packet/main/install.sh | bash -s -- --wire-repo
```

### Local checkout install

When the `llm_wiki_prompt_packet` checkout is already on disk:

- `bash ./install.sh --wire-repo` (from inside the neutral repo, with `install.sh` from the packet checkout)
- `python <llm_wiki_prompt_packet>/installers/install_g_kade_workspace.py --workspace <neutral-repo>`
- `bash <llm_wiki_prompt_packet>/installers/install_g_kade_workspace.sh --workspace <neutral-repo>`

### Legacy packet CLI (still supported)

- `powershell -NoProfile -ExecutionPolicy Bypass -File <llm_wiki_prompt_packet>\support\scripts\llm_wiki_packet.ps1 init --project-root <neutral-repo>`
- `python <llm_wiki_prompt_packet>\support\scripts\llm_wiki_packet.py init --project-root <neutral-repo>`

Prefer `--wire-repo` for new setups.

The bootstrap must leave these benchmark surfaces inside the neutral repo:

- `scripts/llm_wiki_packet.py`
- `scripts/llm_wiki_packet.ps1`
- `scripts/run_pokemon_benchmark.ps1`
- `scripts/pokemon_benchmark_adapter.py`
- `scripts/run_llm_wiki_agent.ps1`
- `.llm-wiki/skill-pipeline/failures/`
- repo-local `pokemon-benchmark` skill surfaces under `.agents`, `.codex`, and `.claude`
- optional home skill surfaces where supported, including `C:\Users\prest\.pi\agent\skills\pokemon-benchmark`

## Run Order

1. Run the smoke benchmark first:
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\llm_wiki_packet.ps1 pokemon-benchmark smoke`
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run_pokemon_benchmark.ps1 -Mode smoke`
2. If the smoke run passes and a full framework run is requested, run:
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\llm_wiki_packet.ps1 pokemon-benchmark framework --agent codex`
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run_pokemon_benchmark.ps1 -Mode framework -Agent codex`
3. Only override benchmark paths if the Gym-Anything checkout moved. The installed script already defaults to the packet's supported Pokemon task.
4. Treat the framework run as "target harness plus `pokemon-benchmark` launcher skill", not as the launcher skill by itself.

## What To Report

Read the printed `result.json` path and report from that file instead of guessing from console output.

Always surface these fields when present:

- `success`
- `verifier.passed`
- `stdout_path`
- `stderr_path`
- `failure_capture.new_paths`
- `failure_capture.manual_record`
- `task_contract_path`
- `prompt_path`

The normal result location pattern is:

- `.artifacts/pokemon-benchmark/runs/<run-id>/result.json`

Failure artifacts stay in the existing packet plane:

- `.llm-wiki/skill-pipeline/failures/events`
- `.llm-wiki/skill-pipeline/failures/clusters`
- `.llm-wiki/skill-pipeline/failures/benchmarks`

## Constraints

- Run the benchmark from the neutral repo after bootstrap, not from the packet source checkout.
- Reuse the installed wrapper and failure-capture surfaces. Do not invent a parallel log format.
- Prefer the smoke path before the framework run.
- Do not claim success until `result.json` says the verifier passed.
- Do not mutate the Gym-Anything task contract unless adapter compatibility strictly requires it.
