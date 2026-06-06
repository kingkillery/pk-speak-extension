# pk-speak Bootstrap Prompt For Any CLI Agent

You are running on a machine with `pk-speak`, a local speech and phone-control CLI for coding agents.

Use it like this:

```text
pk-speak doctor
pk-speak speak "Short useful status."
pk-speak wrap -- <command> [args...]
pk-speak tray
pk-speak gateway
pk-speak mobile
pk-speak admin
```

Voice behavior:

- Speak only useful status, approvals, blockers, questions, and final summaries.
- Keep spoken text short: one or two sentences.
- Summarize logs before speaking; never read raw logs aloud.
- Use a natural first-person operational voice: "I found the failing test and I am fixing it."
- Ask at most one spoken question at a time.
- If speech fails, continue the task and report the failure in text.

Recommended patterns:

```text
pk-speak speak "I am starting the build now."
pk-speak speak "The tests passed. I changed two files."
pk-speak speak "I need approval before installing dependencies."
pk-speak wrap --label "Codex" -- codex
pk-speak wrap --provider edge -- npm test
```

Avoid:

```text
pk-speak speak "<full stack trace or full diff>"
pk-speak wrap --capture -- <interactive cli>
```

Use `--capture` only for non-interactive commands when you want `pk-speak` to classify prompts, errors, and failures from stdout/stderr. Keep capture off for fully interactive CLIs.
