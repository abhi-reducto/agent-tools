/**
 * Taskbar Footer Extension
 *
 * Colorful status bar with the current directory, tokens, cost, context-window meter, model, and branch.
 * Auto-enabled on session start; use /cost-toggle to show/hide.
 * Use /pwd [directory] to show or change the working directory without clearing history.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function abbrModel(id: string): string {
	if (!id) return "─";
	return id
		.replace(/^(anthropic\/|openai\/|google\/|mistral\/|cohere\/|groq\/|perplexity\/)*/, "")
		.replace(/:?$/, "")
		.replace(/-(latest|preview|\d{4}-\d{2}-\d{2})$/, "")
		.slice(0, 22);
}

function contextMeter(percent: number, barWidth: number): string {
	const filled = Math.max(0, Math.min(barWidth, Math.round((percent / 100) * barWidth)));
	return "█".repeat(filled) + "░".repeat(barWidth - filled);
}

function contextColor(percent: number): "success" | "warning" | "error" {
	if (percent >= 85) return "error";
	if (percent >= 60) return "warning";
	return "success";
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	function makeFooter(ctx: ExtensionContext) {
		return (_tui: any, theme: any, footerData: any) => {
			const unsub = footerData.onBranchChange(() => _tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let inputTokens = 0;
					let outputTokens = 0;
					let totalCost = 0;

					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							inputTokens += m.usage?.input ?? 0;
							outputTokens += m.usage?.output ?? 0;
							totalCost += m.usage?.cost?.total ?? 0;
						}
					}

					const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
					const costColor = totalCost > 0.1 ? "error" : totalCost > 0 ? "warning" : "success";

					// ── Context meter ─────────────────────────────────────
					const usage = ctx.getContextUsage();
					let contextLeft = "";
					if (usage && usage.percent !== null) {
						const barW = width >= 90 ? 8 : width >= 70 ? 6 : 4;
						const barRaw = contextMeter(usage.percent, barW);
						const barColored = theme.fg(contextColor(usage.percent), barRaw);
						const pctStr = theme.fg(contextColor(usage.percent), `${Math.round(usage.percent)}%`);
						contextLeft = `${theme.fg("dim", "ctx")} ${barColored} ${pctStr}`;
					}

					// ── Left side: current directory + tokens + cost ─────
					const left = [
						theme.fg("dim", ctx.cwd),
						theme.fg("accent", fmt(inputTokens)),
						theme.fg("dim", "⇡"),
						theme.fg("accent", fmt(outputTokens)),
						theme.fg("dim", "⇣"),
						theme.fg(costColor, `$${totalCost.toFixed(3)}`),
						contextLeft,
					].filter(Boolean).join(" ");

					// ── Right side: model + branch ──────────────────────
					const branch = footerData.getGitBranch();
					const modelStr = theme.fg("accent", abbrModel(ctx.model?.id ?? ""));
					const branchStr = branch ? theme.fg("dim", branch) : "";
					const right = [modelStr, branchStr].filter(Boolean).join(" ");

					// Pad between them
					const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

					return [truncateToWidth(left + gap + right, width)];
				},
			};
		};
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui" && enabled) {
			ctx.ui.setFooter(makeFooter(ctx));
		}
	});

	pi.registerCommand("cost-toggle", {
		description: "Toggle the cost viewer footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (ctx.mode === "tui") {
				if (enabled) {
					ctx.ui.setFooter(makeFooter(ctx));
					ctx.ui.notify("Cost viewer enabled", "info");
				} else {
					ctx.ui.setFooter(undefined);
					ctx.ui.notify("Cost viewer disabled", "info");
				}
			}
		},
	});

	pi.registerCommand("pwd", {
		description: "Show or change the working directory while preserving session history: /pwd [directory]",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(ctx.cwd, "info");
				return;
			}

			const target = raw === "~"
				? homedir()
				: raw.startsWith("~/")
					? resolve(homedir(), raw.slice(2))
					: resolve(ctx.cwd, raw);

			try {
				if (!statSync(target).isDirectory()) {
					ctx.ui.notify(`Not a directory: ${target}`, "error");
					return;
				}
			} catch {
				ctx.ui.notify(`Directory not found: ${target}`, "error");
				return;
			}

			if (target === ctx.cwd) {
				ctx.ui.notify(`Already in ${target}`, "info");
				return;
			}

			try {
				const sourcePath = ctx.sessionManager.getSessionFile();
				let targetPath: string;

				if (sourcePath && existsSync(sourcePath)) {
					// Rebuild cwd-bound tools and prompts while copying the full session tree.
					targetPath = SessionManager.forkFrom(sourcePath, target).getSessionFile()!;
				} else {
					// Fresh and in-memory sessions may not have a source file yet.
					const targetSession = SessionManager.create(target);
					targetPath = targetSession.getSessionFile()!;
					const header = targetSession.getHeader();
					if (!header) throw new Error("Failed to create the target session");
					const entries = [header, ...ctx.sessionManager.getEntries()];
					writeFileSync(targetPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
				}

				const result = await ctx.switchSession(targetPath, {
					withSession: async (newCtx) => {
						newCtx.ui.notify(`Working directory: ${target} (session history preserved)`, "info");
					},
				});

				if (result.cancelled) {
					rmSync(targetPath, { force: true });
					ctx.ui.notify("Working directory change cancelled", "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to change working directory: ${message}`, "error");
			}
		},
	});
}
