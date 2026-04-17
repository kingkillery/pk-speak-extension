#!/usr/bin/env node

const USAGE = [
  "pi-speak-admin - management pane for pi-speak session routing",
  "",
  "Usage:",
  "  pi-speak-admin [--help]",
  "",
  "The full Ink-based dashboard lands in a later iteration; this stub",
  "exists so /sess ui has something to launch and so the UI build toolchain",
  "is wired up end-to-end.",
].join("\n");

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  console.log("pi-speak-admin stub (run with --help for usage).");
  return 0;
}

process.exit(main(process.argv));
