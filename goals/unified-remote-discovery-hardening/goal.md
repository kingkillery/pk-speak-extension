**Goal**

Finish and harden Pi Speak's Unified Remote-style discovery flow. The gateway should be discoverable by Android through mDNS first and UDP fallback second, while QR/manual setup remains the reliable Tailscale fallback and no public discovery surface leaks credentials.

**Shared Understanding**

See `facts.md` for the testable behavior this goal must preserve.

**Execution Plan**

See `plan.md` for the ordered implementation and verification plan.

**Done Condition**

The remaining QA gaps are closed, `npm test` and Android debug build pass, the updated APK is installed on the connected phone, mDNS and UDP discovery are verified, and only relevant project files are staged/committed.
