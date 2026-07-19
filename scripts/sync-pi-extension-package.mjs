import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(".");
const target = resolve("packages", "pi-pk-speak");

const packageJson = {
	name: "pi-pk-speak",
	version: readRootPackage().version,
	type: "module",
	description: "Pi extension for conversational PK Speak voice, wake-word, mobile, and session routing.",
	keywords: [
		"pi",
		"pi-coding-agent",
		"extension",
		"speech",
		"voice",
		"remote-control",
		"pk-speak",
	],
	main: "dist/index.js",
	bin: {
		"pi-speak-admin": "dist/ui/admin.js",
		"pi-speak-gateway": "dist/headless-gateway.js",
		"pi-speak-tray": "dist/persistent-tray.js",
		"pi-speak-qr": "scripts/qr-setup.mjs",
		"pi-speak-mcp": "dist/pk-speak-mcp.js",
	},
	files: [
		"dist",
		"!dist/pi-speak-pk.*",
		"web",
		"assets",
		"android-app/.build-outputs/app-debug.apk",
		"listener",
		"!listener/__pycache__",
		"!listener/**/*.pyc",
		"unified-remote",
		"scripts/qr-setup.mjs",
		"SKILL.md",
		"CHANGELOG.md",
		"README.md",
	],
	dependencies: readRootPackage().dependencies,
	engines: {
		node: ">=20",
	},
	publishConfig: {
		access: "public",
	},
};

sync();

function sync() {
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
	writeFileSync(join(target, "README.md"), renderReadme());
	for (const file of ["CHANGELOG.md", "SKILL.md"]) {
		copyIfExists(join(root, file), join(target, file));
	}
	for (const dir of ["dist", "web", "assets", "listener", "unified-remote"]) {
		copyDir(join(root, dir), join(target, dir));
	}
	copyIfExists(
		join(root, "android-app", ".build-outputs", "app-debug.apk"),
		join(target, "android-app", ".build-outputs", "app-debug.apk"),
	);
	copyIfExists(join(root, "android-app", "README.md"), join(target, "android-app", "README.md"));
	copyIfExists(join(root, "scripts", "qr-setup.mjs"), join(target, "scripts", "qr-setup.mjs"));
	console.log(`Synced ${packageJson.name}@${packageJson.version} to ${target}`);
}

function readRootPackage() {
	return JSON.parse(copyText(join(root, "package.json")));
}

function renderReadme() {
	return [
		"# pi-pk-speak",
		"",
		"Standalone Pi extension package for PK Speak.",
		"",
		"Install this inside Pi:",
		"",
		"```text",
		"pi npm i pi-pk-speak",
		"```",
		"",
		"This package contains the actual Pi extension entrypoint (`dist/index.js`), session manager UI, gateway/tray helpers, listener assets, Android APK, and remote web app.",
		"",
		"For the desktop/bootstrap CLI, use the sibling `pk-speak` package from the main GitHub repo.",
		"",
	].join("\n");
}

function copyText(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : "{}";
}

function copyIfExists(source, destination) {
	if (!existsSync(source)) return;
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
}

function copyDir(source, destination) {
	if (!existsSync(source)) return;
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source)) {
		const sourcePath = join(source, entry);
		if (shouldSkip(sourcePath)) continue;
		const destinationPath = join(destination, entry);
		const stat = statSync(sourcePath);
		if (stat.isDirectory()) {
			copyDir(sourcePath, destinationPath);
		} else if (stat.isFile()) {
			copyFileIfChanged(sourcePath, destinationPath);
		}
	}
}

function copyFileIfChanged(source, destination) {
	const sourceText = readFileSync(source);
	if (existsSync(destination)) {
		const destinationText = readFileSync(destination);
		if (sourceText.equals(destinationText)) return;
	}
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, sourceText);
}

function shouldSkip(path) {
	return path.includes("__pycache__") || path.endsWith(".pyc") || path.endsWith(".tsbuildinfo");
}
