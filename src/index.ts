import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

type Preset = "silent" | "minimal" | "balanced" | "debug";

type PiGlanceColors = {
	readBg: number;
	readFg: number;
	editBg: number;
	editFg: number;
	writeBg: number;
	writeFg: number;
	bashBg: number;
	bashFg: number;
	grepBg: number;
	grepFg: number;
	findBg: number;
	findFg: number;
	lsBg: number;
	lsFg: number;
};

type PiGlanceConfig = {
	enabled: boolean;
	preset: Preset;
	thinking: { visible: boolean; defaultExpanded: boolean; mode: "full" | "first-lines" | "indicator" | "hidden"; maxLines: number; maxChars: number };
	assistantText: { liveStream: boolean; finalMode: "full" | "truncated"; maxFinalLines: number; maxFinalChars: number };
	tools: { visible: boolean; displayMode: "one-line" | "compact" | "full" | "hidden"; oneLineBackground: "blue" | "accent" | "none"; showArgs: boolean; argsMaxChars: number; collapseByDefault: boolean; groupParallelTools: boolean };
	colors: PiGlanceColors;
	bash: { outputVisible: boolean; storeHiddenOutput: boolean; viewer: { enabled: boolean; maxStoredCommands: number; defaultView: "stdout" | "stderr" | "combined"; pageSize: number } };
	errors: { alwaysShow: boolean; expandRelatedTool: boolean; showBashOutputOnError: boolean };
	shortcuts: { togglePiGlance: string; toggleToolDetails: string; openBashViewer: string; nextBashOutput: string; previousBashOutput: string; scrollBashDown: string; scrollBashUp: string; closeOverlay: string };
};

type OutputRecord = {
	id: string;
	type: "bash" | "read" | "user_bash";
	command: string;
	output: string;
	filePath?: string;
	startLine?: number;
	exitCode?: number;
	isError?: boolean;
	timestamp: number;
};

const OUTPUT_VIEWER_BOTTOM_MARGIN = 3;
const OUTPUT_VIEWER_CHROME_LINES = 8;

const DEFAULT_CONFIG: PiGlanceConfig = {
	enabled: true,
	preset: "minimal",
	thinking: { visible: true, defaultExpanded: true, mode: "full", maxLines: 200, maxChars: 20_000 },
	assistantText: { liveStream: true, finalMode: "full", maxFinalLines: 500, maxFinalChars: 50_000 },
	tools: { visible: true, displayMode: "one-line", oneLineBackground: "blue", showArgs: false, argsMaxChars: 120, collapseByDefault: true, groupParallelTools: true },
	colors: {
		readBg: 22,
		readFg: 245,
		editBg: 94,
		editFg: 245,
		writeBg: 130,
		writeFg: 245,
		bashBg: 17,
		bashFg: 245,
		grepBg: 60,
		grepFg: 245,
		findBg: 60,
		findFg: 245,
		lsBg: 240,
		lsFg: 245,
	},
	bash: { outputVisible: false, storeHiddenOutput: true, viewer: { enabled: true, maxStoredCommands: 20, defaultView: "combined", pageSize: 20 } },
	errors: { alwaysShow: true, expandRelatedTool: true, showBashOutputOnError: true },
	shortcuts: {
		togglePiGlance: "ctrl+shift+c",
		toggleToolDetails: "ctrl+alt+b",
		openBashViewer: "ctrl+shift+b",
		nextBashOutput: "ctrl+shift+right",
		previousBashOutput: "ctrl+shift+left",
		scrollBashDown: "ctrl+shift+down",
		scrollBashUp: "ctrl+shift+up",
		closeOverlay: "escape",
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep<T>(base: T, patch: unknown): T {
	if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		out[key] = key in out ? mergeDeep(out[key], value) : value;
	}
	return out as T;
}

async function readJson(path: string): Promise<unknown | undefined> {
	if (!existsSync(path)) return undefined;
	return JSON.parse(await readFile(path, "utf8"));
}

async function loadConfig(cwd: string): Promise<PiGlanceConfig> {
	let config = DEFAULT_CONFIG;
	const globalConfig = await readJson(join(homedir(), ".pi", "agent", "pi-glance.json"));
	if (globalConfig) config = mergeDeep(config, globalConfig);
	const projectConfig = await readJson(join(cwd, ".pi", "pi-glance.json"));
	if (projectConfig) config = mergeDeep(config, projectConfig);
	return config;
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item: any) => (item?.type === "text" ? item.text : ""))
		.filter(Boolean)
		.join("\n");
}

function exitCodeFromOutput(output: string): number | undefined {
	const match = output.match(/(?:exit code|Command exited with code)[: ]+(\d+)/i);
	return match ? Number(match[1]) : undefined;
}

function outputFromBashDetails(details: any, fallback: string): { output: string; exitCode?: number } {
	const output =
		(typeof details?.output === "string" && details.output) ||
		[details?.stdout, details?.stderr].filter((x) => typeof x === "string" && x.length > 0).join("\n") ||
		fallback;
	const exitCode =
		typeof details?.exitCode === "number" ? details.exitCode : typeof details?.code === "number" ? details.code : exitCodeFromOutput(output);
	return { output, exitCode };
}

const BLUE_BG = "\x1b[44m";
const RESET_BG = "\x1b[49m";
const RESET_FG = "\x1b[39m";

type GlanceToolName = "read" | "edit" | "write" | "bash" | "grep" | "find" | "ls";

function isGlanceToolName(value: string): value is GlanceToolName {
	return ["read", "edit", "write", "bash", "grep", "find", "ls"].includes(value);
}

function ansiColorCode(value: number, fallback: number): number {
	return Number.isInteger(value) && value >= 0 && value <= 255 ? value : fallback;
}

function colorBadge(text: string, bg: number, fg = 245): string {
	return `\x1b[38;5;${ansiColorCode(fg, 245)}m\x1b[48;5;${ansiColorCode(bg, 0)}m${text}${RESET_BG}${RESET_FG}`;
}

function toolBadge(text: string, toolName: GlanceToolName, config: PiGlanceConfig): string {
	const colors = config.colors;
	if (toolName === "read") return colorBadge(text, colors.readBg, colors.readFg);
	if (toolName === "edit") return colorBadge(text, colors.editBg, colors.editFg);
	if (toolName === "write") return colorBadge(text, colors.writeBg, colors.writeFg);
	if (toolName === "bash") return colorBadge(text, colors.bashBg, colors.bashFg);
	if (toolName === "grep") return colorBadge(text, colors.grepBg, colors.grepFg);
	if (toolName === "find") return colorBadge(text, colors.findBg, colors.findFg);
	return colorBadge(text, colors.lsBg, colors.lsFg);
}

function bgBlue(text: string): string {
	return `${BLUE_BG}${text}${RESET_BG}`;
}

function formatArgs(args: any, maxChars: number): string {
	const raw = typeof args?.command === "string" ? args.command.replace(/\s+/g, " ").trim() : JSON.stringify(args ?? {});
	return raw.length > maxChars ? `${raw.slice(0, Math.max(0, maxChars - 1))}…` : raw;
}

function formatLineCount(count: number): string {
	return `${count} line${count === 1 ? "" : "s"} read`;
}

function truncateWithSuffix(text: string, suffix: string, maxChars: number): string {
	const raw = `${text}${suffix}`;
	if (raw.length <= maxChars) return raw;
	if (suffix.length >= maxChars) return raw.slice(0, Math.max(0, maxChars - 1)) + "…";
	const textMax = Math.max(0, maxChars - suffix.length - 1);
	return `${text.slice(0, textMax)}…${suffix}`;
}

function formatPathFilename(args: any): string {
	const path = typeof args?.path === "string" && args.path ? args.path : "unknown path";
	return path === "unknown path" ? path : basename(path) || path;
}

function formatEditSentence(args: any, maxChars: number): string {
	const filename = formatPathFilename(args);
	const editCount = Array.isArray(args?.edits) ? args.edits.length : undefined;
	const suffix = editCount !== undefined ? ` · ${editCount} edit${editCount === 1 ? "" : "s"}` : "";
	return truncateWithSuffix(`edit ${filename}`, suffix, maxChars);
}

function formatWriteSentence(args: any, maxChars: number): string {
	return truncateWithSuffix(`write ${formatPathFilename(args)}`, "", maxChars);
}

function formatReadSentence(args: any, maxChars: number, lineCount?: number): string {
	const path = typeof args?.path === "string" && args.path ? args.path : "unknown path";
	const parts = [`read ${path}`];
	if (args?.offset !== undefined) parts.push(`from line ${args.offset}`);
	if (args?.limit !== undefined) parts.push(`limit ${args.limit}`);
	const base = parts.join(" ").replace(/\s+/g, " ").trim();
	const suffix = lineCount !== undefined ? ` · ${formatLineCount(lineCount)}` : "";
	return truncateWithSuffix(base, suffix, maxChars);
}

function countReadLines(output: string, details: any): number {
	const truncationLines = details?.truncation?.outputLines;
	if (typeof truncationLines === "number" && Number.isFinite(truncationLines)) return truncationLines;
	if (!output) return 0;

	const lines = output.split(/\r?\n/);
	const lastLine = lines[lines.length - 1]?.trim() ?? "";
	if (/^\[(?:\d+ more lines in file|Showing lines \d+-\d+ of .+)\. Use offset=\d+ to continue\.\]$/.test(lastLine)) {
		lines.pop();
		if (lines[lines.length - 1] === "") lines.pop();
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

function renderToolLine(theme: Theme, toolName: string, label: string, rest: string, config: PiGlanceConfig): string {
	const line = ` ${label}${rest ? ` ${rest}` : ""} `;
	if (isGlanceToolName(toolName)) return toolBadge(line, toolName, config);
	if (config.tools.oneLineBackground === "blue") return bgBlue(line);
	if (config.tools.oneLineBackground === "accent") return theme.bg("selectedBg", line);
	return line;
}

function renderCommandBackground(theme: Theme, record: OutputRecord, config: PiGlanceConfig, text: string): string {
	if (record.type === "read") return toolBadge(text, "read", config);
	if (record.type === "bash" || record.type === "user_bash") return toolBadge(text, "bash", config);
	if (config.tools.oneLineBackground === "blue") return bgBlue(text);
	if (config.tools.oneLineBackground === "accent") return theme.bg("selectedBg", text);
	return text;
}

function formatExitPrefix(theme: Theme, exitCode: number | undefined, done: boolean | undefined): string {
	if (!done) return theme.fg("warning", "[…]");
	if (exitCode === 0) return theme.fg("success", "[exit 0]");
	if (exitCode !== undefined) return theme.fg("error", `[exit ${exitCode}]`);
	return theme.fg("dim", "[done]");
}

function keyId(key: string): KeyId {
	return key as KeyId;
}

function expandTabs(text: string, tabSize = 4): string {
	return text.replace(/\t/g, " ".repeat(tabSize));
}

function sanitizeOutputLine(text: string): string {
	return expandTabs(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function languageFromPath(path: string | undefined): string {
	const ext = extname(path ?? "").toLowerCase();
	if ([".ts", ".tsx"].includes(ext)) return "typescript";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
	if ([".json", ".jsonc"].includes(ext)) return "json";
	if ([".md", ".markdown"].includes(ext)) return "markdown";
	if ([".py", ".pyw"].includes(ext)) return "python";
	if ([".sh", ".bash", ".zsh", ".fish"].includes(ext)) return "shell";
	if ([".css", ".scss", ".sass", ".less"].includes(ext)) return "css";
	if ([".html", ".htm", ".xml", ".svg"].includes(ext)) return "markup";
	if ([".yml", ".yaml"].includes(ext)) return "yaml";
	if ([".rs"].includes(ext)) return "rust";
	if ([".go"].includes(ext)) return "go";
	if ([".java", ".kt", ".kts", ".swift", ".c", ".h", ".cpp", ".cc", ".hpp", ".cs"].includes(ext)) return "c-like";
	return "text";
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightNonStringCode(theme: Theme, text: string, language: string): string {
	const common = ["if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return", "try", "catch", "finally", "throw", "new", "class", "extends", "implements", "import", "export", "from", "as", "async", "await", "function", "const", "let", "var", "type", "interface", "enum", "public", "private", "protected", "static", "readonly", "default"];
	const byLanguage: Record<string, string[]> = {
		python: ["def", "class", "if", "elif", "else", "for", "while", "try", "except", "finally", "with", "as", "return", "yield", "import", "from", "lambda", "pass", "break", "continue", "raise", "async", "await", "True", "False", "None"],
		shell: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "in", "export", "local", "return", "exit"],
		rust: ["fn", "let", "mut", "pub", "impl", "trait", "struct", "enum", "match", "if", "else", "for", "while", "loop", "return", "use", "mod", "crate", "self", "Self", "async", "await", "where", "const", "static"],
		go: ["func", "package", "import", "type", "struct", "interface", "var", "const", "if", "else", "for", "range", "switch", "case", "default", "return", "defer", "go", "select", "chan"],
	};
	const keywords = byLanguage[language] ?? (language === "text" ? [] : common);
	const keywordSet = new Set(keywords);
	const keywordPattern = keywords.length > 0 ? `\\b(?:${keywords.map(escapeRegExp).join("|")})\\b|` : "";
	const tokenPattern = new RegExp(`${keywordPattern}\\b(?:true|false|null|undefined|NaN|Infinity|0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?)\\b|[{}()[\\],.;:+*\\/%=<>!&|?-]`, "g");
	return text.replace(tokenPattern, (m) => {
		if (keywordSet.has(m)) return theme.fg("accent", m);
		if (/^[{}()[\],.;:+*\/%=<>!&|?-]$/.test(m)) return theme.fg("dim", m);
		return theme.fg("warning", m);
	});
}

function highlightCodeLine(theme: Theme, line: string, language: string): string {
	if (language === "text") return line;
	if (language === "json") {
		return line.replace(/("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null|-?\d+(?:\.\d+)?)\b/g, (m) => {
			if (/^"(?:\\.|[^"\\])*"\s*:$/.test(m)) return theme.fg("accent", m);
			if (m.startsWith('"')) return theme.fg("success", m);
			return theme.fg("warning", m);
		});
	}
	if (language === "markdown") {
		if (/^\s*#{1,6}\s/.test(line)) return theme.fg("accent", line);
		return line.replace(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g, (m) => theme.fg("accent", m));
	}
	if (language === "yaml") {
		return line.replace(/^(\s*[-?]?\s*)([\w.-]+)(\s*:)/, (_m, p1, p2, p3) => `${p1}${theme.fg("accent", p2)}${p3}`);
	}
	if (language === "markup") {
		return line.replace(/(<\/?[\w:-]+|\/?>|\s[\w:-]+(?==))/g, (m) => theme.fg(m.startsWith(" ") ? "warning" : "accent", m));
	}

	const commentStart = (() => {
		if (["python", "shell"].includes(language)) return line.indexOf("#");
		const slash = line.indexOf("//");
		return slash >= 0 ? slash : line.indexOf("/*");
	})();
	const code = commentStart >= 0 ? line.slice(0, commentStart) : line;
	const comment = commentStart >= 0 ? line.slice(commentStart) : "";
	const stringPattern = /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
	let out = "";
	let last = 0;
	for (const match of code.matchAll(stringPattern)) {
		out += highlightNonStringCode(theme, code.slice(last, match.index), language);
		out += theme.fg("success", match[0]);
		last = (match.index ?? 0) + match[0].length;
	}
	out += highlightNonStringCode(theme, code.slice(last), language);
	return comment ? `${out}${theme.fg("dim", comment)}` : out;
}

function emptyComponent() {
	return { render: () => [], invalidate() {} };
}

class PiGlanceHelpViewer {
	constructor(private readonly theme: Theme, private readonly config: PiGlanceConfig, private readonly outputCount: number, private readonly done: () => void) {}

	handleInput(data: string): void {
		if (matchesKey(data, keyId(this.config.shortcuts.closeOverlay)) || matchesKey(data, "escape")) this.done();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(38, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (s: string) => {
			const clipped = truncateToWidth(expandTabs(s), innerW);
			return th.fg("border", "│") + pad(clipped) + th.fg("border", "│");
		};
		return [
			th.fg("border", `╭${"─".repeat(innerW)}╮`),
			row(` ${th.fg("accent", th.bold("Pi Glance help"))}`),
			row(""),
			row(" Pi Glance makes Pi's transcript quieter by collapsing tool"),
			row(" details into compact one-line summaries. Bash/read output can"),
			row(" be hidden from the main transcript and reopened later."),
			row(""),
			row(" Commands:"),
			row("   /glance help                  Show this help"),
			row("   /glance status                Show current state"),
			row("   /glance on | off              Enable or disable"),
			row("   /glance preset <name>         silent|minimal|balanced|debug"),
			row("   /glance output                Open saved bash/read output"),
			row("   /glance reload-config         Reload config files"),
			row(""),
			row(" Shortcuts:"),
			row(`   ${this.config.shortcuts.togglePiGlance}        Toggle Pi Glance`),
			row(`   ${this.config.shortcuts.toggleToolDetails}          Expand/collapse tool details`),
			row(`   ${this.config.shortcuts.openBashViewer}        Open output viewer`),
			row("   arrows in viewer                  Navigate/scroll output"),
			row(`   ${this.config.shortcuts.closeOverlay}               Close overlays`),
			row(""),
			row(" Config files:"),
			row("   ~/.pi/agent/pi-glance.json    Global config"),
			row("   .pi/pi-glance.json            Project config overrides global"),
			row(""),
			row(` Current: ${this.config.enabled ? "on" : "off"}, preset=${this.config.preset}, outputs=${this.outputCount}`),
			row(` ${th.fg("dim", "Esc close")}`),
			th.fg("border", `╰${"─".repeat(innerW)}╯`),
		];
	}

	invalidate(): void {}
}

class OutputViewer {
	private selected: number;
	private scroll = 0;
	private cachedWidth?: number;
	private cachedPageSize?: number;
	private cachedLines?: string[];

	constructor(
		private readonly theme: Theme,
		private readonly records: OutputRecord[],
		private readonly config: PiGlanceConfig,
		private readonly done: () => void,
		private readonly getPageSize: () => number = () => config.bash.viewer.pageSize,
	) {
		this.selected = Math.max(0, records.length - 1);
	}

	private pageSize(): number {
		return Math.max(1, Math.floor(this.getPageSize()));
	}

	private selectedOutputLineCount(): number {
		const rec = this.records[this.selected];
		return rec ? rec.output.split(/\r?\n/).length : 0;
	}

	handleInput(data: string): void {
		if (matchesKey(data, keyId(this.config.shortcuts.closeOverlay)) || matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (matchesKey(data, keyId(this.config.shortcuts.previousBashOutput)) || matchesKey(data, "left")) {
			this.selected = Math.max(0, this.selected - 1);
			this.scroll = 0;
			this.invalidate();
			return;
		}
		if (matchesKey(data, keyId(this.config.shortcuts.nextBashOutput)) || matchesKey(data, "right")) {
			this.selected = Math.min(this.records.length - 1, this.selected + 1);
			this.scroll = 0;
			this.invalidate();
			return;
		}
		if (matchesKey(data, keyId(this.config.shortcuts.scrollBashDown)) || matchesKey(data, "down")) {
			const pageSize = this.pageSize();
			this.scroll = Math.min(Math.max(0, this.selectedOutputLineCount() - pageSize), this.scroll + pageSize);
			this.invalidate();
			return;
		}
		if (matchesKey(data, keyId(this.config.shortcuts.scrollBashUp)) || matchesKey(data, "up")) {
			this.scroll = Math.max(0, this.scroll - this.pageSize());
			this.invalidate();
		}
	}

	render(width: number): string[] {
		const pageSize = this.pageSize();
		if (this.cachedLines && this.cachedWidth === width && this.cachedPageSize === pageSize) return this.cachedLines;
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (s: string) => {
			const clipped = truncateToWidth(expandTabs(s), innerW);
			return th.fg("border", "│") + pad(clipped) + th.fg("border", "│");
		};
		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", th.bold("Pi Glance output viewer"))}`));
		if (this.records.length === 0) {
			lines.push(row(" No bash/read output captured yet."));
		} else {
			const rec = this.records[this.selected]!;
			const status = rec.exitCode === undefined ? "" : rec.exitCode === 0 ? th.fg("success", `exit ${rec.exitCode}`) : th.fg("error", `exit ${rec.exitCode}`);
			lines.push(row(` ${this.selected + 1}/${this.records.length} ${rec.type}${status ? ` ${status}` : ""}`));
			const prefix = rec.type === "read" ? "" : "$ ";
			const commandText = ` ${prefix}${truncateToWidth(rec.command.replace(/\s+/g, " "), Math.max(10, innerW - 3 - prefix.length))} `;
			lines.push(row(renderCommandBackground(th, rec, this.config, commandText)));
			lines.push(row(th.fg("dim", " ─".repeat(Math.floor(innerW / 2)))));
			const outLines = rec.output.split(/\r?\n/);
			this.scroll = Math.min(this.scroll, Math.max(0, outLines.length - pageSize));
			const page = outLines.slice(this.scroll, this.scroll + pageSize);
			const language = rec.type === "read" ? languageFromPath(rec.filePath) : "text";
			const startLine = rec.startLine ?? 1;
			const lineNoWidth = String(startLine + Math.max(0, outLines.length - 1)).length;
			page.forEach((line, idx) => {
				const clean = sanitizeOutputLine(line);
				if (rec.type === "read") {
					const lineNo = th.fg("dim", String(startLine + this.scroll + idx).padStart(lineNoWidth));
					const gutter = `${lineNo} ${th.fg("dim", "│")}`;
					lines.push(row(` ${gutter} ${highlightCodeLine(th, clean, language)}`));
				} else {
					lines.push(row(` ${clean}`));
				}
			});
			if (this.scroll + page.length < outLines.length) lines.push(row(th.fg("dim", ` … ${outLines.length - this.scroll - page.length} more line(s)`)));
		}
		lines.push(row(` ${th.fg("dim", "←/→ previous/next • ↑/↓ scroll • Esc close")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		this.cachedWidth = width;
		this.cachedPageSize = pageSize;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedPageSize = undefined;
		this.cachedLines = undefined;
	}
}

export default function piGlance(pi: ExtensionAPI) {
	let config: PiGlanceConfig = DEFAULT_CONFIG;
	let toolsRegistered = false;
	let toolDetailsExpanded = false;
	const outputRecords: OutputRecord[] = [];
	const activeTools = new Map<string, { name: string; started: number; done?: boolean; error?: boolean }>();

	function addOutputRecord(record: OutputRecord) {
		if (!config.bash.storeHiddenOutput) return;
		const existingIndex = outputRecords.findIndex((r) => r.id === record.id);
		if (existingIndex >= 0) outputRecords[existingIndex] = record;
		else outputRecords.push(record);
		while (outputRecords.length > config.bash.viewer.maxStoredCommands) outputRecords.shift();
	}

	function applyUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("pi-glance", config.enabled ? ctx.ui.theme.fg("accent", `glance:${config.preset}`) : ctx.ui.theme.fg("dim", "glance:off"));
		ctx.ui.setToolsExpanded(toolDetailsExpanded || !config.enabled ? true : !config.tools.collapseByDefault);
		if (config.enabled) ctx.ui.setWorkingMessage(config.thinking.visible ? undefined : "Working…");
	}

	function updateToolWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!config.enabled || !config.tools.visible || config.tools.displayMode === "one-line" || config.tools.displayMode === "compact") {
			ctx.ui.setWidget("pi-glance-tools", undefined);
			return;
		}
		const items = [...activeTools.values()].slice(-6);
		if (items.length === 0) {
			ctx.ui.setWidget("pi-glance-tools", undefined);
			return;
		}
		const lines = [
			items
				.map((t) => {
					const text = `${t.error ? "✗" : t.done ? "✓" : "…"} ${t.name}`;
					return isGlanceToolName(t.name) ? toolBadge(` ${text} `, t.name, config) : text;
				})
				.join(" "),
		];
		ctx.ui.setWidget("pi-glance-tools", (_tui, _theme) => ({
			render(width: number) {
				return [truncateToWidth(lines[0], width)];
			},
			invalidate() {},
		}), { placement: "belowEditor" });
	}

	async function showOutputViewer(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		await ctx.ui.custom<void>((tui, theme, _kb, done) => new OutputViewer(theme, outputRecords, config, done, () => tui.terminal.rows - OUTPUT_VIEWER_BOTTOM_MARGIN - OUTPUT_VIEWER_CHROME_LINES), {
			overlay: true,
			overlayOptions: { anchor: "bottom-right", width: "40%", minWidth: 44, maxHeight: "100%", margin: { right: 1, bottom: OUTPUT_VIEWER_BOTTOM_MARGIN } },
		});
	}

	async function showHelp(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Pi Glance: compact tool summaries; use /glance on|off|status|preset <name>|output|reload-config", "info");
			return;
		}
		await ctx.ui.custom<void>((_tui, theme, _kb, done) => new PiGlanceHelpViewer(theme, config, outputRecords.length, done), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "58%", minWidth: 64, maxHeight: "90%", margin: 1 },
		});
	}

	function registerToolOverrides(ctx: ExtensionContext) {
		if (toolsRegistered) return;
		toolsRegistered = true;
		const tools = {
			read: createReadToolDefinition(ctx.cwd),
			bash: createBashToolDefinition(ctx.cwd),
			edit: createEditToolDefinition(ctx.cwd),
			write: createWriteToolDefinition(ctx.cwd),
			grep: createGrepToolDefinition(ctx.cwd),
			find: createFindToolDefinition(ctx.cwd),
			ls: createLsToolDefinition(ctx.cwd),
		};
		const activeToolNames = new Set(pi.getActiveTools());
		for (const [name, tool] of Object.entries(tools)) {
			if (!activeToolNames.has(name)) continue;
			pi.registerTool({
				...(tool as any),
				renderShell: "self",
				async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, execCtx: ExtensionContext) {
					if (name !== "bash") return (tool as any).execute(toolCallId, params, signal, onUpdate, execCtx as any);
					try {
						const result = await (tool as any).execute(toolCallId, params, signal, onUpdate, execCtx as any);
						const fallback = textFromContent((result as any).content);
						const { output, exitCode } = outputFromBashDetails((result as any).details, fallback);
						addOutputRecord({ id: toolCallId, type: "bash", command: String(params?.command ?? ""), output, exitCode, isError: exitCode !== undefined && exitCode !== 0, timestamp: Date.now() });
						return result;
					} catch (error) {
						const output = error instanceof Error ? error.message : String(error);
						const match = output.match(/Command exited with code (\d+)/);
						const exitCode = match ? Number(match[1]) : undefined;
						addOutputRecord({ id: toolCallId, type: "bash", command: String(params?.command ?? ""), output, exitCode, isError: true, timestamp: Date.now() });
						throw error;
					}
				},
				renderCall(args: any, theme: Theme, renderCtx: any) {
					if (!config.enabled || config.tools.displayMode === "full") {
						if (typeof (tool as any).renderCall === "function") return (tool as any).renderCall(args, theme, renderCtx);
					}
					if (!config.tools.visible || config.tools.displayMode === "hidden") return emptyComponent();

					if (name === "read") {
						const lineCount = renderCtx?.state?.piGlanceReadLineCount;
						const sentence = formatReadSentence(args, config.tools.argsMaxChars, typeof lineCount === "number" ? lineCount : undefined);
						return { render: (width: number) => [truncateToWidth(toolBadge(` ${sentence} `, "read", config), width)], invalidate() {} };
					}

					if (name === "edit") {
						const sentence = formatEditSentence(args, config.tools.argsMaxChars);
						return { render: (width: number) => [truncateToWidth(toolBadge(` ${sentence} `, "edit", config), width)], invalidate() {} };
					}

					if (name === "write") {
						const sentence = formatWriteSentence(args, config.tools.argsMaxChars);
						return { render: (width: number) => [truncateToWidth(toolBadge(` ${sentence} `, "write", config), width)], invalidate() {} };
					}

					const showRest = name === "bash" || config.tools.showArgs || toolDetailsExpanded || config.tools.displayMode === "compact";
					const rest = showRest ? theme.fg("dim", formatArgs(args, config.tools.argsMaxChars)) : "";
					const label = name === "bash" ? `${formatExitPrefix(theme, renderCtx?.state?.piGlanceExitCode, renderCtx?.state?.piGlanceDone)} $` : name;
					return { render: (width: number) => [truncateToWidth(renderToolLine(theme, name, label, rest, config), width)], invalidate() {} };
				},
				renderResult(result: any, options: any, theme: Theme, renderCtx: any) {
					const isError = !!renderCtx?.isError || !!result?.isError;
					if (name === "read" && !isError) {
						const lineCount = countReadLines(textFromContent(result?.content), result?.details);
						if (renderCtx?.state && renderCtx.state.piGlanceReadLineCount !== lineCount) {
							renderCtx.state.piGlanceReadLineCount = lineCount;
							renderCtx.invalidate?.();
						}
					}
					if (!config.tools.visible || config.tools.displayMode === "hidden") return emptyComponent();
					if (!config.enabled || config.tools.displayMode === "full" || toolDetailsExpanded || (isError && config.errors.expandRelatedTool)) {
						if (typeof (tool as any).renderResult === "function") return (tool as any).renderResult(result, options, theme, renderCtx);
						const raw = textFromContent(result?.content);
						return { render: (width: number) => raw.split("\n").map((l) => truncateToWidth(l, width)), invalidate() {} };
					}
					if (name === "bash") {
						const fallback = textFromContent(result?.content);
						const { output, exitCode } = outputFromBashDetails(result?.details, fallback);
						const nextExitCode = exitCode ?? (isError ? 1 : 0);
						if (renderCtx?.state) {
							const changed = renderCtx.state.piGlanceExitCode !== nextExitCode || renderCtx.state.piGlanceDone !== true;
							renderCtx.state.piGlanceExitCode = nextExitCode;
							renderCtx.state.piGlanceDone = true;
							if (changed) renderCtx.invalidate?.();
						}
						if (config.bash.outputVisible) {
							const firstLines = output.split(/\r?\n/).slice(0, 30).join("\n");
							return { render: (width: number) => firstLines.split("\n").map((l) => truncateToWidth(l, width)), invalidate() {} };
						}

						// Collapsed mode means the transcript/screen output contains only the
						// renderCall() line (the command). Do not add a second status/result line.
						return emptyComponent();
					}
					if (name === "read" || name === "edit" || name === "write") {
						return emptyComponent();
					}
					const line = `${theme.fg("success", "✓")} ${name} ${theme.fg("dim", "completed; Ctrl+Alt+B for details")}`;
					return { render: (width: number) => [truncateToWidth(line, width)], invalidate() {} };
				},
			});
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			config = await loadConfig(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`Pi Glance config error: ${(error as Error).message}`, "error");
			config = DEFAULT_CONFIG;
		}
		registerToolOverrides(ctx);
		applyUi(ctx);
	});

	pi.on("tool_execution_start", (event: any, ctx) => {
		activeTools.set(event.toolCallId, { name: event.toolName, started: Date.now() });
		updateToolWidget(ctx);
	});

	pi.on("tool_result", (event: any) => {
		if (event.toolName === "bash") {
			const fallback = textFromContent(event.content);
			const { output, exitCode } = outputFromBashDetails(event.details, fallback);
			addOutputRecord({
				id: event.toolCallId,
				type: "bash",
				command: String(event.input?.command ?? ""),
				output,
				exitCode: exitCode ?? (event.isError ? 1 : undefined),
				isError: !!event.isError || (exitCode !== undefined && exitCode !== 0),
				timestamp: Date.now(),
			});
			return;
		}

		if (event.toolName === "read") {
			const output = textFromContent(event.content);
			const lineCount = event.isError ? undefined : countReadLines(output, event.details);
			const startLine = typeof event.input?.offset === "number" && Number.isFinite(event.input.offset) ? Math.max(1, event.input.offset) : 1;
			addOutputRecord({
				id: event.toolCallId,
				type: "read",
				command: formatReadSentence(event.input, 500, lineCount),
				output,
				filePath: typeof event.input?.path === "string" ? event.input.path : undefined,
				startLine,
				isError: !!event.isError,
				timestamp: Date.now(),
			});
		}
	});

	pi.on("tool_execution_end", (event: any, ctx) => {
		const rec = activeTools.get(event.toolCallId);
		if (rec) {
			rec.done = true;
			rec.error = !!event.isError;
		}
		updateToolWidget(ctx);
	});

	pi.on("user_bash", (event: any) => {
		const local = createLocalBashOperations();
		return {
			operations: {
				async exec(command: string, cwd: string, options: any) {
					const chunks: Buffer[] = [];
					const result = await local.exec(command, cwd, {
						...options,
						onData(data: Buffer) {
							chunks.push(data);
							options.onData(data);
						},
					});
					const output = Buffer.concat(chunks).toString("utf8");
					addOutputRecord({
						id: `user-bash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
						type: "user_bash",
						command: String(event.command ?? command),
						output,
						exitCode: result.exitCode ?? undefined,
						isError: result.exitCode !== null && result.exitCode !== 0,
						timestamp: Date.now(),
					});
					return result;
				},
			},
		};
	});

	pi.on("agent_end", (_event, ctx) => {
		activeTools.clear();
		ctx.ui.setWidget("pi-glance-tools", undefined);
	});

	pi.registerCommand("glance", {
		description: "Configure Pi Glance: help, status, on, off, preset <name>, output, reload-config.",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0] ?? "status";
			if (cmd === "help") {
				await showHelp(ctx);
				return;
			}
			if (cmd === "on") config.enabled = true;
			else if (cmd === "off") config.enabled = false;
			else if (cmd === "preset") {
				const preset = parts[1] as Preset;
				if (!["silent", "minimal", "balanced", "debug"].includes(preset)) {
					ctx.ui.notify("Usage: /glance preset [silent|minimal|balanced|debug]", "error");
					return;
				}
				config.preset = preset;
			} else if (cmd === "output") {
				await showOutputViewer(ctx);
				return;
			} else if (cmd === "reload-config") {
				config = await loadConfig(ctx.cwd);
			} else if (cmd !== "status") {
				ctx.ui.notify("Usage: /glance [help|status|on|off|preset <name>|output|reload-config]", "error");
				return;
			}
			applyUi(ctx);
			ctx.ui.notify(`Pi Glance ${config.enabled ? "on" : "off"}, preset=${config.preset}, outputs=${outputRecords.length}`, "info");
		},
	});

	pi.registerShortcut(keyId(DEFAULT_CONFIG.shortcuts.togglePiGlance), {
		description: "Toggle Pi Glance",
		handler: async (ctx) => {
			config.enabled = !config.enabled;
			applyUi(ctx);
			ctx.ui.notify(`Pi Glance ${config.enabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerShortcut(keyId(DEFAULT_CONFIG.shortcuts.toggleToolDetails), {
		description: "Toggle Pi Glance tool details",
		handler: async (ctx) => {
			toolDetailsExpanded = !toolDetailsExpanded;
			applyUi(ctx);
			ctx.ui.notify(`tool details ${toolDetailsExpanded ? "expanded" : "collapsed"}`, "info");
		},
	});

	pi.registerShortcut(keyId(DEFAULT_CONFIG.shortcuts.openBashViewer), {
		description: "Open Pi Glance output viewer",
		handler: async (ctx) => showOutputViewer(ctx),
	});

	pi.registerShortcut("ctrl+alt+o", {
		description: "Open Pi Glance output viewer",
		handler: async (ctx) => showOutputViewer(ctx),
	});
}
