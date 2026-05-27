/**
 * Live Tail Compaction Extension
 *
 * Performs live compaction of the conversation tail by intercepting the
 * `context` event (messages sent to the LLM) and replacing old turns with
 * summaries. This is entirely in-flight — the session file retains full
 * history. A custom footer replaces pi's built-in one to display OUR
 * context percentage (based on what the LLM actually sees after compaction)
 * instead of pi's session-state-based percentage.
 *
 * Architecture:
 *   - `context` event: intercept messages, compact old turns into summaries
 *   - Custom footer: shows our context % (compact-aware), token stats, model
 *   - `session_before_compact` / `session_compact`: reset state if pi compacts
 *
 * Settings (in ~/.pi/agent/settings.json or .pi/settings.json):
 * {
 *   "liveCompaction": {
 *     "enabled": true,
 *     "startThreshold": 0.7,
 *     "stopThreshold": 0.4,
 *     "provider": null,
 *     "model": null,
 *     "compactionPromptFile": "compaction-prompt.md"
 *   }
 * }
 *
 * By default, uses the current active model and provider for compaction.
 * Set provider + model to use a cheaper/faster model for summarization.
 */

import { complete } from "@earendil-works/pi-ai";
import type { AgentMessage, AssistantMessage, ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveCompactionSettings {
	enabled: boolean;
	startThreshold: number;
	stopThreshold: number;
	provider: string | null;
	model: string | null;
	compactionPromptFile: string;
}

/** Our tracked compaction state — what the LLM actually sees */
interface CompactionState {
	compactedTurnCount: number;
	accumulatedSummary: string;
	/** Token count from last message_end (accurate, updated each LLM turn).
	 *  Used as anchor for the delta estimation and for footer display. */
	lastCompactedTokens: number;
	/** estimateMessageTokens value at the last context event.
	 *  Used to compute growth delta between context events. */
	lastEstimateTokens: number;
	contextWindow: number;
	/** After compaction, the estimated token count is unreliable. Set this flag
	 *  to indicate we're waiting for a real message_end measurement. While true,
	 *  don't trigger compaction (token count is unknown). */
	awaitingRealMeasurement: boolean;
}
// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Load the bundled defaults from settings.json next to this extension file.
 * These serve as the base layer, overridden by global and project settings.
 */
function loadBundledDefaults(): LiveCompactionSettings {
	try {
		const fs = require("fs");
		const path = require("path");
		const thisDir = path.dirname(__filename);
		const defaultsPath = path.join(thisDir, "settings.json");
		const raw = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));
		const lc = raw.liveCompaction as Record<string, unknown>;

		return {
			enabled: lc?.enabled !== undefined ? !!lc.enabled : true,
			startThreshold: typeof lc?.startThreshold === "number" ? lc.startThreshold : 0.7,
			stopThreshold: typeof lc?.stopThreshold === "number" ? lc.stopThreshold : 0.4,
			provider: typeof lc?.provider === "string" ? lc.provider : null,
			model: typeof lc?.model === "string" ? lc.model : null,
			compactionPromptFile: typeof lc?.compactionPromptFile === "string" ? lc.compactionPromptFile : "compaction-prompt.md",
		};
	} catch {
		return {
			enabled: true,
			startThreshold: 0.7,
			stopThreshold: 0.4,
			provider: null,
			model: null,
			compactionPromptFile: "compaction-prompt.md",
		};
	}
}

/**
 * Resolve a compactionPromptFile to its actual text content.
 * Relative paths resolve against the extension's directory.
 */
function loadCompactionPrompt(promptFile: string): string {
	try {
		const fs = require("fs");
		const path = require("path");
		const thisDir = path.dirname(__filename);
		return fs.readFileSync(path.join(thisDir, promptFile), "utf8");
	} catch {
		return "";
	}
}

// ── State ────────────────────────────────────────────────────────────────────

let isCompacting = false;
let compactionJustRan = false;
/** Reference to TUI for requesting footer re-renders during autonomous loops. */
let tuiRef: { requestRender(force?: boolean): void } | null = null;
let compactionState: CompactionState = {
	compactedTurnCount: 0,
	accumulatedSummary: "",
	lastCompactedTokens: 0,
	lastEstimateTokens: 0,
	contextWindow: 0,
};
// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Load settings with a 3-layer merge:
 *   1. Bundled defaults (settings.json next to this extension)
 *   2. Global user settings (~/.pi/agent/settings.json)
 *   3. Project settings (.pi/settings.json)
 *
 * Each layer overrides the previous. Null provider/model means "use current model".
 */
function loadSettings(): LiveCompactionSettings {
	const defaults = loadBundledDefaults();

	try {
		const fs = require("fs");
		const path = require("path");
		const os = require("os");

		// Global settings
		const globalPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		let globalLc: Record<string, unknown> = {};
		try {
			const globalSettings = JSON.parse(fs.readFileSync(globalPath, "utf8"));
			globalLc = (globalSettings.liveCompaction as Record<string, unknown>) ?? {};
		} catch {}

		// Project settings
		let projectLc: Record<string, unknown> = {};
		try {
			const projectSettings = JSON.parse(fs.readFileSync(".pi/settings.json", "utf8"));
			projectLc = (projectSettings.liveCompaction as Record<string, unknown>) ?? {};
		} catch {}

		// Merge: bundled → global → project
		const raw: Record<string, unknown> = {
			...globalLc,
			...projectLc,
		};

		return {
			enabled: raw.enabled !== undefined ? !!raw.enabled : defaults.enabled,
			startThreshold: typeof raw.startThreshold === "number" ? raw.startThreshold : defaults.startThreshold,
			stopThreshold: typeof raw.stopThreshold === "number" ? raw.stopThreshold : defaults.stopThreshold,
			provider: typeof raw.provider === "string" && raw.provider.length > 0 ? raw.provider : defaults.provider,
			model: typeof raw.model === "string" && raw.model.length > 0 ? raw.model : defaults.model,
			compactionPromptFile: typeof raw.compactionPromptFile === "string" && raw.compactionPromptFile.length > 0 ? raw.compactionPromptFile : defaults.compactionPromptFile,
		};
	} catch {
		return defaults;
	}
}

// ── Turn Boundary Detection ──────────────────────────────────────────────────

/**
 * A "turn" starts at each user message and includes all subsequent messages
 * (assistant, toolResult, bashExecution, etc.) until the next user message.
 */
function findTurnBoundaries(messages: AgentMessage[]): Array<{ start: number; end: number }> {
	const turns: Array<{ start: number; end: number }> = [];
	let turnStart = -1;

	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") {
			if (turnStart >= 0) {
				turns.push({ start: turnStart, end: i });
			}
			turnStart = i;
		}
	}

	if (turnStart >= 0) {
		turns.push({ start: turnStart, end: messages.length });
	}

	return turns;
}

// ── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: AgentMessage[]): number {
	return estimateTokens(serializeConversation(convertToLlm(messages)));
}

// ── Summarization ────────────────────────────────────────────────────────────

async function summarizeMessages(
	messages: AgentMessage[],
	previousSummary: string | undefined,
	settings: LiveCompactionSettings,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<string> {
	// Resolve model: configured or current
	let compactionModel;
	if (settings.provider && settings.model) {
		compactionModel = ctx.modelRegistry.find(settings.provider, settings.model);
	} else {
		compactionModel = ctx.model;
	}

	if (!compactionModel) {
		throw new Error("No compaction model available");
	}

	// Resolve auth
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(compactionModel);
	if (!auth.ok) {
		throw new Error(`Compaction auth failed: ${auth.error}`);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for compaction model ${compactionModel.provider}/${compactionModel.id}`);
	}

	// Serialize messages to text
	const conversationText = serializeConversation(convertToLlm(messages));

	// Build prompt from template
	const previousSummaryBlock = previousSummary
		? `<previous-summaries>\n${previousSummary}\n</previous-summaries>`
		: "";

	const prompt = loadCompactionPrompt(settings.compactionPromptFile)
		.replace("{previousSummaryBlock}", previousSummaryBlock)
		.replace("{conversationText}", conversationText);

	// Send to compaction model in a blank session (no system prompt, no prior context)
	const summaryMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: prompt }],
			timestamp: Date.now(),
		},
	];

	const response = await complete(
		compactionModel,
		{ messages: summaryMessages },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 4096,
			signal,
		},
	);

	const contentBlocks = response.content ?? [];
	const summary = contentBlocks
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	if (!summary.trim()) {
		throw new Error("Compaction produced an empty summary");
	}

	return summary;
}
// ── Footer ───────────────────────────────────────────────────────────────────

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext) {
	ctx.ui.setFooter((tui, theme, footerData) => {
		tuiRef = tui; // Save for requestRender from event handlers
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				// ── Line 1: pwd + git branch ──
				let pwd = ctx.sessionManager.getCwd();
				const home = process.env.HOME || process.env.USERPROFILE || "";
				if (home && pwd.startsWith(home)) {
					pwd = "~" + pwd.slice(home.length);
				}
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				const pwdLine = theme.fg("dim", pwd);

				// ── Line 2: token stats + our context % + model ──
				// Calculate cumulative usage from all session entries
				let totalInput = 0;
				let totalOutput = 0;
				let totalCacheRead = 0;
				let totalCacheWrite = 0;
				let totalCost = 0;
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const m = entry.message as AssistantMessage;
						const usage = m.usage;
						if (!usage) continue;
						totalInput += usage.input;
						totalOutput += usage.output;
						totalCacheRead += usage.cacheRead;
						totalCacheWrite += usage.cacheWrite;
						totalCost += usage.cost?.total ?? 0;
					}
				}

				const statsParts: string[] = [];
				statsParts.push(`↑${formatTokens(totalInput)}`);
				statsParts.push(`↓${formatTokens(totalOutput)}`);
				if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
				if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

				const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
				if (totalCost || usingSubscription) {
					statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				}

				// ── OUR context percentage (based on compacted state) ──
				const cw = compactionState.contextWindow || ctx.model?.contextWindow || 0;
				let contextStr: string;
				if (compactionState.awaitingRealMeasurement) {
					// Just compacted — real count unknown until next LLM response
					contextStr = cw > 0 ? `~?%/${formatTokens(cw)}` : `?/${formatTokens(cw)}`;
				} else {
					const compactedPct = cw > 0 ? (compactionState.lastCompactedTokens / cw) * 100 : 0;
					const pctDisplay = cw > 0
						? `${compactedPct.toFixed(1)}%/${formatTokens(cw)}`
						: `?/${formatTokens(cw)}`;
					if (compactedPct > 90) {
						contextStr = theme.fg("error", pctDisplay);
					} else if (compactedPct > 70) {
						contextStr = theme.fg("warning", pctDisplay);
					} else {
						contextStr = pctDisplay;
					}
				}
				statsParts.push(contextStr);

				// ── Model on the right ──
				const modelName = ctx.model?.id || "no-model";
				let rightSide = modelName;
				if (ctx.model?.reasoning) {
					const thinkingLevel = ctx.getThinkingLevel?.() || "off";
					rightSide = thinkingLevel === "off"
						? `${modelName} • thinking off`
						: `${modelName} • ${thinkingLevel}`;
				}
				if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
					rightSide = `(${ctx.model.provider}) ${rightSide}`;
				}

				let statsLeft = statsParts.join(" ");
				let statsLeftWidth = visibleWidth(statsLeft);

				// Truncate stats if too wide
				const maxStatsWidth = Math.floor(width * 0.7);
				if (statsLeftWidth > maxStatsWidth) {
					statsLeft = truncateToWidth(statsLeft, maxStatsWidth);
					statsLeftWidth = visibleWidth(statsLeft);
				}

				const rightWidth = visibleWidth(rightSide);
				const totalNeeded = statsLeftWidth + 2 + rightWidth;

				let statsLine: string;
				if (totalNeeded <= width) {
					const padding = " ".repeat(width - statsLeftWidth - rightWidth);
					statsLine = theme.fg("dim", statsLeft) + padding + theme.fg("dim", rightSide);
				} else {
					statsLine = theme.fg("dim", truncateToWidth(statsLeft, width));
				}

				// ── Line 3: extension statuses ──
				const lines = [pwdLine, statsLine];
				const extensionStatuses = footerData.getExtensionStatuses();
				if (extensionStatuses.size > 0) {
					const sortedStatuses = Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text);
					const statusLine = sortedStatuses.join(" ");
					lines.push(truncateToWidth(statusLine, width));
				}

				return lines;
			},
		};
	});
}

/** Request a footer re-render (safe to call from any handler). */
function requestFooterRender() {
	tuiRef?.requestRender();
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	pi.on("session_start", async (_event, ctx) => {
		isCompacting = false;

		// Rebuild compaction state from session entries (persists across reloads)
		const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown; message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }>;
		let savedCompactedTurnCount = 0;
		let savedAccumulatedSummary = "";
		let savedLastInputTokens = 0;

		let savedAwaitingRealMeasurement = false;

		for (const entry of entries) {
			// Restore ALL compaction state from lc-state entries (last-write-wins)
			if (entry.type === "custom" && entry.customType === "lc-state" && entry.data) {
				const state = entry.data as {
					compactedTurnCount?: number;
					accumulatedSummary?: string;
					lastInputTokens?: number;

					awaitingRealMeasurement?: boolean;
				};
				savedCompactedTurnCount = state.compactedTurnCount ?? savedCompactedTurnCount;
				savedAccumulatedSummary = state.accumulatedSummary ?? savedAccumulatedSummary;

				savedLastInputTokens = state.lastInputTokens ?? savedLastInputTokens;
				savedAwaitingRealMeasurement = state.awaitingRealMeasurement ?? savedAwaitingRealMeasurement;
			}

			// Scan assistant messages for usage (ground truth: input + cacheRead + cacheWrite)
			// Only do this BEFORE compaction — post-compaction, these values are from
			// the un-compacted context and would overestimate.
			if (savedCompactedTurnCount === 0 && entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
				const u = entry.message.usage;
				const totalInput = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				if (totalInput > savedLastInputTokens) savedLastInputTokens = totalInput;
			}
		}

		// CRITICAL: after compaction, we cannot trust any persisted token count.
		// Old lc-state entries may have pre-compaction overestimates.
		// ctx.getContextUsage() also returns the full un-compacted session size.
		// The ONLY reliable source is a message_end measurement from THIS session.
		// So: if we've ever compacted, always start in awaitingRealMeasurement mode.
		// The first LLM response's usage will give us the real count.
		if (savedCompactedTurnCount > 0) {
			savedAwaitingRealMeasurement = true;
			savedLastInputTokens = 0;

		}

		// If no compaction has happened, use pi's estimate or scan assistant messages
		const initialUsage = (savedCompactedTurnCount === 0) ? ctx.getContextUsage() : undefined;
		const initialTokens = savedAwaitingRealMeasurement ? 0 : (savedLastInputTokens || initialUsage?.tokens || 0);

		compactionState = {
			compactedTurnCount: savedCompactedTurnCount,
			accumulatedSummary: savedAccumulatedSummary,
			lastCompactedTokens: initialTokens,
			lastEstimateTokens: 0, // Reset: will be set at first context event
			contextWindow: ctx.model?.contextWindow ?? 0,

			awaitingRealMeasurement: savedAwaitingRealMeasurement,
		};

		// Install our custom footer (replaces pi's built-in)
		installFooter(pi, ctx);
	});

	/**
	 * The `context` event fires before each LLM call with a deep copy of the
	 * messages. We modify this array in-flight:
	 *   1. Re-apply any previously compacted turns (replace with summary)
	 *   2. Check if we need to compact more turns
	 *   3. If so, summarize additional turns and update our state
	 *   4. Return the modified messages
	 *
	 * The session file is never modified — full history is preserved.
	 * Our custom footer shows the context % based on compacted state.
	 */
	pi.on("context", async (event, ctx) => {
		const settings = loadSettings();
		if (!settings.enabled) return;

		const contextWindow = ctx.model?.contextWindow ?? compactionState.contextWindow;
		compactionState.contextWindow = contextWindow;

		// Step 1: Find turn boundaries in the raw messages from session
		const turns = findTurnBoundaries(event.messages);
		if (turns.length === 0) return;

		// Step 2: Re-apply any previously compacted turns
		// The session always gives us full unmodified messages, so we replace
		// the first N turns (already compacted) with our accumulated summary.
		let messages: AgentMessage[] = [...event.messages];

		if (compactionState.compactedTurnCount > 0) {
			const alreadyCompactedCount = Math.min(compactionState.compactedTurnCount, turns.length);
			if (alreadyCompactedCount > 0) {
				const compactedEnd = turns[alreadyCompactedCount - 1].end;
				const preMessages = messages.slice(0, turns[0].start); // messages before first turn
				const postMessages = messages.slice(compactedEnd);

				// Replace compacted turns with a single summary user message
				const summaryMessage = {
					role: "user" as const,
					content: `[LIVE TAIL COMPACTION]\n\nThe following is a summary of earlier conversation that has been compacted to free context space. Treat this as authoritative history:\n\n${compactionState.accumulatedSummary}\n\n[END COMPACTION]`,
					timestamp: Date.now(),
				};

				messages = [...preMessages, summaryMessage, ...postMessages];
			}
		}

		// Step 3: Check if we need to compact MORE turns
		//
		// Token counting strategy: anchored delta approach.
		//
		// The most accurate source is usage.input from message_end (provider tokenizer).
		// But between message_end measurements, context grows from tool results.
		// We bridge this gap by estimating the GROWTH (delta) since the last context event
		// and adding it to the accurate message_end baseline.
		//
		// The delta approach has ~2-5% error (proportional to growth, not total),
		// while a raw estimateMessageTokens call has ~15-30% error (proportional to total),
		// and the frozen baseline approach has unbounded error (never grows at all).
		//
		// Key: lastCompactedTokens is ONLY updated by message_end (accurate).
		// We do NOT overwrite it with the lossy estimate — it stays pristine for the footer
		// and as the delta anchor. The lossy estimate only contributes the growth delta.
		const rawEstimate = estimateMessageTokens(messages);
		let currentTokens: number;
		if (compactionState.awaitingRealMeasurement) {
			// Just compacted — token count unknown until next message_end.
			// Don't trigger compaction. Save estimate for future delta computation.
			currentTokens = 0;
		} else if (compactionState.lastCompactedTokens > 0 && compactionState.lastEstimateTokens > 0) {
			// Anchored delta: real baseline from message_end + estimated growth since last context event.
			// The delta captures single-turn spikes (large tool outputs) that the frozen
			// baseline would miss entirely.
			const delta = Math.max(0, rawEstimate - compactionState.lastEstimateTokens);
			currentTokens = compactionState.lastCompactedTokens + delta;
		} else if (compactionState.lastCompactedTokens > 0) {
			// Have a message_end baseline but no prior estimate (first context event after measurement).
			// Use pi's estimate if available (pre-compaction), otherwise raw estimate.
			if (compactionState.compactedTurnCount === 0) {
				const sessionUsage = ctx.getContextUsage();
				const piEstimate = sessionUsage?.tokens ?? 0;
				currentTokens = Math.max(compactionState.lastCompactedTokens, piEstimate);
			} else {
				currentTokens = rawEstimate;
			}
		} else {
			// No message_end measurement yet — fall back to pi's estimate or our raw estimate.
			const sessionUsage = ctx.getContextUsage();
			currentTokens = sessionUsage?.tokens ?? rawEstimate;
		}
		compactionState.lastEstimateTokens = rawEstimate;
		requestFooterRender(); // Update footer during autonomous loops
		const usageRatio = contextWindow > 0 ? currentTokens / contextWindow : 0;

		// Trigger compaction when:
		// Trigger compaction when above start threshold.
		// Don't compact while awaiting real measurement — token count is unknown.
		// This prevents spurious re-compaction after reload.
		const shouldCompact = !compactionState.awaitingRealMeasurement && usageRatio > settings.startThreshold;

		if (!shouldCompact || isCompacting) {

			if (compactionState.compactedTurnCount > 0) {
				return { messages };
			}
			return;
		}

		// Step 4: Need to compact more turns
		isCompacting = true;
		try {
			// We must work with the ORIGINAL turn boundaries (from session),
			// not the re-applied ones, since the summary message replaced them.
			const turnsAfterCompaction = turns.slice(compactionState.compactedTurnCount);
			if (turnsAfterCompaction.length < 1) return;

			// Multi-round tail compaction strategy:
			//   Each round compacts the OLDEST uncompacted turns.
			//   - Minimum per round: 10% of context window
			//   - Hard ceiling: never compact the most recent messages
			//     (keep recent context intact for the agent to work with)
			//   - If still above start threshold after a round,
			//     the delta approach will naturally trigger another round

			// Ceiling: protect the most recent messages from compaction.
			// Use a message-count ceiling rather than user-turn boundaries.
			// This works in autonomous loops where there may be only 1 user turn
			// (the initial prompt) followed by dozens of assistant/tool rounds.
			//
			// Scan the uncompacted messages from the end to find a cutoff point
			// that protects the last N messages. A "message boundary" is a point
			// between two messages where a user message follows — this ensures
			// we don't split an assistant+toolResult pair.
			const MIN_PROTECTED_MESSAGES = 20;
			const uncompactedMsgs = event.messages.slice(
				turnsAfterCompaction[0].start,
				turnsAfterCompaction[turnsAfterCompaction.length - 1].end
			);
			let ceilingMsgIdx = uncompactedMsgs.length - MIN_PROTECTED_MESSAGES;

			// Snap ceiling to the nearest user message boundary going backward.
			// This ensures we don't cut in the middle of a tool exchange.
			// (A boundary is where the next message has role === "user")
			while (ceilingMsgIdx > 0 && uncompactedMsgs[ceilingMsgIdx]?.role !== "user") {
				ceilingMsgIdx--;
			}
			if (ceilingMsgIdx <= 0) return; // Can't compact — too few messages

			// Map ceilingMsgIdx back to a turn index — find the turn whose
			// messages end at or before this ceiling position.
			let ceilingTurnIdx = 0;
			for (let i = 0; i < turnsAfterCompaction.length; i++) {
				const turnEndRel = turnsAfterCompaction[i].end - turnsAfterCompaction[0].start;
				if (turnEndRel <= ceilingMsgIdx) {
					ceilingTurnIdx = i + 1;
				} else {
					break;
				}
			}
			if (ceilingTurnIdx === 0) return; // Nothing to compact

			const minSavings = Math.floor(contextWindow * 0.1);
			let newCompactCount = 0;
			let estimatedSavings = 0;
			const summaryOverhead = 500;

			// Compact oldest turns, one at a time, until we've freed
			// at least 10% of context. Never go past the ceiling.
			for (let i = 0; i < ceilingTurnIdx; i++) {
				const turn = turnsAfterCompaction[i];
				const turnMessages = event.messages.slice(turn.start, turn.end);
				estimatedSavings += estimateMessageTokens(turnMessages);
				newCompactCount = i + 1;

				// Stop once we've freed enough (10% minimum met)
				if (estimatedSavings >= minSavings) {
					break;
				}
			}

			if (newCompactCount === 0) return;

			// Collect the messages to compact (from ORIGINAL event.messages)
			const messagesToCompact: AgentMessage[] = [];
			for (let i = 0; i < newCompactCount; i++) {
				const turn = turnsAfterCompaction[i];
				messagesToCompact.push(...event.messages.slice(turn.start, turn.end));
			}

			if (messagesToCompact.length === 0) return;

			// Summarize
			const signal = ctx.signal ?? new AbortController().signal;
			const summary = await summarizeMessages(
				messagesToCompact,
				compactionState.accumulatedSummary || undefined,
				settings,
				ctx,
				signal,
			);

			// Update compaction state
			compactionState.compactedTurnCount += newCompactCount;
			// The summarizeMessages call already incorporates the previous summary
			// into its output — so just use the new summary directly, don't append.
			// Appending would make the summary grow without bound.
			compactionState.accumulatedSummary = summary;

			// Re-build the message list with ALL compactions applied
			const totalCompacted = compactionState.compactedTurnCount;
			const allCompactedEnd = turns[totalCompacted - 1].end;
			const preMessages = event.messages.slice(0, turns[0].start);
			const postMessages = event.messages.slice(allCompactedEnd);

			const newSummaryMessage = {
				role: "user" as const,
				content: `[LIVE TAIL COMPACTION]\n\nThe following is a summary of earlier conversation that has been compacted to free context space. Treat this as authoritative history:\n\n${compactionState.accumulatedSummary}\n\n[END COMPACTION]`,
				timestamp: Date.now(),
			};

			const newMessages: AgentMessage[] = [
				...preMessages,
				newSummaryMessage,
				...postMessages,
			];

			// Use the estimate for in-session decisions (compactionJustRan allows
			// Use the estimate for in-session decisions (compactionJustRan allows
			// message_end to overwrite with real data), but DON'T persist it as
			// ground truth — it's a lossy heuristic that causes re-compaction on reload.
			compactionState.lastCompactedTokens = estimateMessageTokens(newMessages);
			compactionState.lastEstimateTokens = compactionState.lastCompactedTokens;
			compactionJustRan = true;
			compactionState.awaitingRealMeasurement = true;

			// Check if we need more compaction next round
			const postCompactionRatio = compactionState.lastCompactedTokens / contextWindow;


			// Persist compaction state (survives reloads)
			// lastInputTokens: 0 because the estimate is unreliable — we set
			// awaitingRealMeasurement so session_start knows to wait for message_end.
			pi.appendEntry("lc-state", {
				compactedTurnCount: compactionState.compactedTurnCount,
				accumulatedSummary: compactionState.accumulatedSummary,
				lastInputTokens: 0,

				awaitingRealMeasurement: true,
			});

			// Show compaction result as TUI notification (not injected into conversation)
			// Note: we omit the post-compaction % because estimateMessageTokens is lossy
			// (missing system prompt, tool defs, BPE overhead). The footer will show
			// the accurate % once message_end reports the real token count.
			const freedTokens = estimatedSavings - summaryOverhead;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`✦ Tail compaction: ${newCompactCount} turn(s) compacted, ~${freedTokens.toLocaleString()} tokens freed`,
					"info",
				);
			}

			return { messages: newMessages };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(`Tail compaction error: ${msg}`, "error");
			}
			if (compactionState.compactedTurnCount > 0) {
				return { messages };
			}
		} finally {
			isCompacting = false;
		}
	});

	/**
	 * We do NOT cancel pi's compaction — neither auto nor manual.
	 *
	 * If pi auto-compacts: it creates a CompactionEntry, session reloads,
	 * our session_start handler resets compactionState, and we start fresh.
	 * The session messages already include pi's compaction summary, so we
	 * just pass through. No conflict.
	 *
	 * If the user runs /compact: same thing — real compaction, session reload,
	 * state resets. Works exactly as before this plugin.
	 *
	 * Our in-flight compaction via the `context` event is complementary:
	 * it reduces context between pi's compactions, keeping usage in the
	 * 40-70% band. If pi's auto-compaction also fires, that's fine — it
	 * just means context got so large that even our in-flight compaction
	 * wasn't keeping up (e.g. one massive turn), and pi's session-level
	 * compaction takes over.
	 */
	pi.on("session_before_compact", async (_event, _ctx) => {
		// Let all compactions through. Reset our in-flight state since
		// the session will have a real CompactionEntry after this.
		compactionState.compactedTurnCount = 0;
		compactionState.accumulatedSummary = "";

		compactionState.lastEstimateTokens = 0;
	});

	// After session compaction completes, reset our in-flight state.
	// The session now has a real CompactionEntry, context is rebuilt from it.
	pi.on("session_compact", async (_event, ctx) => {
		compactionState.compactedTurnCount = 0;
		compactionState.accumulatedSummary = "";
		compactionState.lastCompactedTokens = 0;
		compactionState.lastEstimateTokens = 0;


		// Persist the reset state
		pi.appendEntry("lc-state", {
			compactedTurnCount: 0,
			accumulatedSummary: "",
			lastInputTokens: 0,

			awaitingRealMeasurement: false,
		});
	});

	// ── Capture real token counts from LLM responses ───────────────────
	//
	// After every LLM response, usage.input tells us the EXACT token count
	// of what was sent. This is the ground truth — no estimation needed.
	// We persist it so it survives reloads.
	//
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			const m = event.message as AssistantMessage;
			if (m.usage) {
				// Total input = uncached + cached (read + write).
				// usage.input alone only counts non-cached tokens, which is
				// much lower than the real context size when caching is active.
				const totalInput = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);

				if (totalInput > 0) {
					const shouldUpdate = compactionJustRan || compactionState.awaitingRealMeasurement || totalInput > compactionState.lastCompactedTokens;
					if (shouldUpdate) {
					compactionState.lastCompactedTokens = totalInput;
					// Keep lastEstimateTokens as-is: the next context event will compute
					// the delta from this estimate (small growth since measurement).
					// Resetting it to 0 would skip the delta branch entirely.
					compactionJustRan = false;
					compactionState.awaitingRealMeasurement = false;
					requestFooterRender(); // Update footer with real measurement
						// Persist the REAL token count (not an estimate)
						pi.appendEntry("lc-state", {
							compactedTurnCount: compactionState.compactedTurnCount,
							accumulatedSummary: compactionState.accumulatedSummary,
							lastInputTokens: totalInput,

							awaitingRealMeasurement: false,
						});
					}
				}
			}
		}
	});

	// ── Custom Message Renderers ────────────────────────────────────────
	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("context-check", {
		description: "Show context usage (our compacted view vs session view)",
		handler: async (_args, ctx) => {
			const ourTokens = compactionState.lastCompactedTokens;
			const cw = compactionState.contextWindow || ctx.model?.contextWindow || 0;
			const ourPct = cw > 0 ? ((ourTokens / cw) * 100).toFixed(1) : "?";

			const sessionUsage = ctx.getContextUsage();
			const sessionPct = sessionUsage?.percent !== null && sessionUsage?.percent !== undefined
				? sessionUsage.percent.toFixed(1)
				: "?";
			const sessionTokens = sessionUsage?.tokens?.toLocaleString() ?? "?";

			const settings = loadSettings();
			const startPct = (settings.startThreshold * 100).toFixed(0);
			const stopPct = (settings.stopThreshold * 100).toFixed(0);
			const modelStr = settings.provider && settings.model
				? `${settings.provider}/${settings.model}`
				: `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"} (current)`;
			const compactedTurns = compactionState.compactedTurnCount;

			if (ctx.hasUI) {
				ctx.ui.notify(
					`Our view: ${ourPct}% (${ourTokens.toLocaleString()}/${cw.toLocaleString()}) | Session view: ${sessionPct}% (${sessionTokens}) | Compacted: ${compactedTurns} turn(s) | Start: ${startPct}%, Stop: ${stopPct}% | Model: ${modelStr}`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("footer-restore", {
		description: "Restore pi's built-in footer (disables our custom footer)",
		handler: async (_args, ctx) => {
			ctx.ui.setFooter(undefined);
			if (ctx.hasUI) ctx.ui.notify("Built-in footer restored", "info");
		},
	});
}
