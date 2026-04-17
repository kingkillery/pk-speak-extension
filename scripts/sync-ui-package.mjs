import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("ui/package.json");
const target = resolve("dist/ui/package.json");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
