# Wiki Log

## 2026-05-07 - skill: installed map-codebase in pk-skills1

- Installed `map-codebase` under `C:\Users\prest\.agents\skills1\pk-skills1`.
- Mirrored the skill to Codex, Pi, Claude, agent, and Helpful-Docs-Prompts skill targets through `managed-skill-sync`.
- Refreshed `~/.codex/skill-index.md` so the skill is discoverable by name, tags, and examples.

## 2026-05-07 - docs: codebase map and remote parity updates

- Added `docs/CODEBASE_MAP.md` as a source-backed architecture and runtime-flow map.
- Updated `wiki/overview.md` for Pi/Codex provider parity, shared remote auth, Android connection modes, Telegram runtime setup, and Bluetooth local-link onboarding.
- Updated validation and README pointers so current remote behavior is discoverable from the codebase docs.

## 2026-05-06T23:20:00Z - decision: tailscale IP-only identifiers

- Recorded preference to reference Tailscale IPs only, not local-network identifiers.
- Required mappings: appserver `100.76.136.91`; jims-mac-mini (mac) `100.76.176.119`; pixel 9a `100.72.61.52`.
- Added app requirement: phone app should make both Mac and MSI/appserver connections available as selectable machine targets.

## 2026-05-06T22:32:59Z - skill: saved `skill-llm-as-a-verifier-cli-skill`

- validation: validated (33)
- kind: workflow
- brief refs: .llm-wiki/skill-pipeline/briefs/20260506-223259--llm-as-a-verifier-cli-skill.md
