# Realtime Voice SELF-DISCOVER Verification

**Verified:** 2026-07-29
**Scope:** `docs/REALTIME_VOICE_PARITY_TODO.md`, `scripts/analyze-voice-metrics.mjs`, and its focused test coverage.

## Result

The three-tier SELF-DISCOVER handoff model is valid for the voice-measurement campaign. The telemetry analyzer now applies the documented, evidence-based acceptance rules without creating an unsupported TTFA or provider-latency gate. Synthetic input remains explicitly non-empirical.

## 1. Three-tier architecture mapping

| Tier | Role in the voice campaign | Required content | Validation boundary |
|---|---|---|---|
| **v7 Task Packet** | Root task contract and campaign authority | backend/model/VAD profile, live-versus-simulated declaration, operator, device/network context, minimum turn and barge-in campaign, and required evidence | Defines what must be measured; does not assert that a measurement passed. |
| **v7 Independent Worker** | Performs one isolated capture/analysis assignment | owned backend/profile, raw console log, SHA-256-bound sidecar manifest, result table, and open issues | Must not combine configurations or silently infer provenance. `validateManifest` rejects incomplete live provenance and configuration mismatches fail closed. |
| **v6 Verification Ledger** | Reconciliation and acceptance record | per-profile row, source/manifest hash, status, executed checks, and remaining live-run work | Accepts only verified live evidence; preserves `UNMEASURED`, `INCOMPLETE`, `FAIL`, `SYNTHETIC FIXTURE`, and `UNVERIFIED` outcomes rather than converting them into a pass. |

The mapping is deliberately one-directional: the Task Packet sets the contract, workers collect bounded evidence, and the ledger reconciles evidence. This prevents a synthetic test fixture or an unproven worker claim from becoming empirical live performance evidence.

**Repository-template note:** no repository artifact named as a versioned v7 Task Packet, v7 Independent Worker, or v6 Verification Ledger was present. This mapping is therefore validated against the supplied handoff contract and the repository's operational equivalents: the parity TODO, manifest-bound analyzer, and generated Markdown table. Before a multi-worker campaign, record the three packets/ledger entries explicitly using the table above.

## 2. Telemetry criteria alignment

The analyzer groups results by campaign and the actual provider/model/turn-detection/eagerness profile. A validated manifest binds the raw-log SHA-256, configuration identity, and—when live—commit, browser, backend implementation, audio device, sample source, provider, model, turn detection, and eagerness.

| Repository criterion | Analyzer behavior | Result |
|---|---|---|
| No recorded turn data is unmeasured | No groups render as `UNMEASURED`; a verified live group containing zero valid turns is also `UNMEASURED`. | Aligned |
| A pass requires at least 20 turns | `PASS` is unavailable below 20 valid turn samples. | Aligned |
| A pass requires at least 5 barge-ins | `PASS` is unavailable below 5 valid barge-in samples. | Aligned |
| Barge-in p95 must be strictly below 200 ms | `PASS` requires `p95BargeIn < 200`. | Aligned |
| A measured barge-in at or above 200 ms fails | A verified live group is `FAIL` when `p95BargeIn >= 200`, including when the minimum barge-in sample count has not yet been reached. | Aligned |
| Insufficient non-failing live data remains incomplete | Live data with one or more turns, no observed threshold failure, and insufficient counts is `INCOMPLETE`. | Aligned |
| Simulated telemetry is not live empirical evidence | `backendMode: "simulated"` produces `SYNTHETIC FIXTURE` and a `[Synthetic Fixture]` profile label. `--require-verified-live` rejects synthetic, unverified, incomplete, and unmeasured results. | Aligned |
| No invented latency gate | TTFA, upstream inference, and local buffer metrics are displayed but do not determine status. | Aligned |

The parity TODO additionally asks operators to report audible-tail observations. The analyzer preserves explicit audible-tail information in the output cell, but the status rule intentionally remains the stated numerical threshold and campaign minimums; no new non-requested status gate was introduced.

## 3. Verification performed

- Focused analyzer suite: `node --test tests/analyze-voice-metrics.test.mjs`
  - **Result:** 7 passed, 0 failed.
  - Covers exact percentile behavior, live-manifest validation, configuration mismatch fail-closed behavior, zero-turn `UNMEASURED`, `>=200 ms` `FAIL`, synthetic labeling, and a manifest-bound verified-live pass.
- Full repository suite: `npm test`
  - **Result:** 627 passed, 0 failed. Build and UI build completed.
  - The earlier PWA failure was resolved by changing the browser import to the served relative ES module and adding the corresponding `/app/barge-in-detector.js` static route; the suite now covers that route and fresh-microphone detector recalibration.

## 4. Residual execution instructions

1. Set `PI_SPEAK_REALTIME_METRICS=1`, restart the gateway, and collect actual browser-console lines beginning with `[pi-speak-voice-metric]` for one real backend/model/VAD profile at a time.
2. Run at least 20 spoken turns and at least 5 real barge-ins for each profile. Do not pool profiles.
3. Generate a sidecar manifest for the exact raw log with `scripts/generate-campaign-manifest.mjs`; supply real commit, browser, resolved backend implementation, audio device, sample source, provider, model, turn detection, and eagerness values.
4. Analyze the exact raw log and manifest:

   ```text
   node scripts/analyze-voice-metrics.mjs --input <raw-console.log> --manifest <campaign-manifest.json> --require-verified-live
   ```

5. Copy the resulting row, raw-log hash, manifest, and operator/run metadata into the v6 verification ledger. Keep `UNMEASURED`, `INCOMPLETE`, `FAIL`, `SYNTHETIC FIXTURE`, and `UNVERIFIED` rows as such; only a verified live `PASS` row is empirical acceptance evidence.

## Remaining limitation

No live microphone/device/network/provider campaign was available in this verification. The repository therefore remains **UNMEASURED** for real voice-feel parity until the residual execution steps are completed for each actual backend/model/configuration.
