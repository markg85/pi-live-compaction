# Live Tail Compaction

Automatically compacts the conversation tail when the context window fills up — entirely in-flight, no session reload, no CompactionEntry. A custom footer replaces pi's built-in footer to show the real context percentage the LLM sees.

## How It Works

1. **Intercepts the `context` event** — fires before each LLM call with the full message list
2. **Re-applies existing compaction** — replaces already-compact turns with the accumulated summary
3. **Estimates current token usage** — uses the anchored delta approach to track context growth between LLM responses
4. **If context > 70%**, compact more turns by summarizing them with a separate LLM call
5. **Returns modified messages** — LLM sees the compacted context, session file unchanged
6. **Custom footer** — replaces pi's built-in footer to show the context % based on what the LLM actually receives
7. **Cancels nothing** — pi's auto-compaction and manual `/compact` both work normally

### Why in-flight (not session compaction)?

Pi's built-in compaction creates `CompactionEntry` objects, reloads the session, and shows the new context %. Our approach is lighter:

- **No session reload** — the agent just continues with modified messages
- **No CompactionEntry** — full history stays intact in the JSONL without compaction artifacts
- **No "actual compaction"** — the LLM sees compacted context, but the session is never compacted
- **Our custom footer** — shows context % based on what we're actually sending the LLM, not session state

### Token tracking: Anchored Delta Approach

Accurate token counting is critical for triggering compaction at the right time. The challenge: the exact token count is only available from the LLM provider's `usage.input` (reported in the `message_end` event after each response), but the context grows continuously during the agent loop as tool results are added.

The extension uses an **anchored delta** approach that combines two sources:

| Source | Role | Accuracy |
|---|---|---|
| `message_end` usage.input | **Anchor** — the exact token count from the provider's tokenizer | Precise |
| `estimateMessageTokens()` | **Delta** — the estimated growth since the last context event | ~2-5% error on the delta |

**How it works:**

```
currentTokens = lastCompactedTokens + max(0, rawEstimate - lastEstimateTokens)
                ^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                accurate baseline      estimated growth since last check
```

- `lastCompactedTokens` — only updated by `message_end` (the ground truth)
- `lastEstimateTokens` — the `estimateMessageTokens()` value from the previous `context` event
- The delta captures single-turn spikes (e.g., a 40k-token file read) that a frozen baseline would miss entirely

**Error comparison:**

| Approach | Error at trigger point | Risk |
|---|---|---|
| Frozen baseline (never grows) | Unbounded — never triggers on spikes | Max token HTTP error |
| Raw `estimateMessageTokens` | 15-30% — triggers at ~85-90% real | Late but survives |
| **Anchored delta** | 2-5% — triggers at ~72-75% real | Reliable |

Each `message_end` resets the anchor, so errors don't accumulate across measurements.

### State tracking across calls

Since `event.messages` is rebuilt fresh from session state each call, we track:

- `compactedTurnCount` — how many turns from the start we've already compacted
- `accumulatedSummary` — the chained summary of those turns
- `lastCompactedTokens` — exact token count from the last `message_end` (for delta anchor and footer display)
- `lastEstimateTokens` — estimated token count from the last `context` event (for delta computation)
- `contextWindow` — cached context window size
- `awaitingRealMeasurement` — after compaction, the token count is unreliable until the next `message_end`

On each `context` event: re-apply our summary for already-compact turns, estimate current token usage via the delta approach, then check if more compaction is needed.

## Installation

```
pi install git:github.com/markg85/pi-live-compaction
```

This adds the package to your `~/.pi/agent/settings.json` automatically.

For auto-discovery, copy the **entire project directory** (not just `live-compaction.ts`) into `~/.pi/agent/extensions/pi-live-compaction/`. The extension relies on `compaction-prompt.md` and `settings.json` at runtime, which are resolved relative to the extension file.

## Configuration


Default settings ship in `settings.json` next to the extension. Override any of them in your pi `settings.json`:

- **Global**: `~/.pi/agent/settings.json`
- **Project**: `.pi/settings.json`

Settings are merged in 3 layers: **bundled defaults → global → project** (project wins).

```json
{
  "liveCompaction": {
    "enabled": true,
    "startThreshold": 0.7,
    "stopThreshold": 0.4,
    "provider": null,
    "model": null,
    "compactionPromptFile": "compaction-prompt.md"
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable live tail compaction |
| `startThreshold` | number | `0.7` | Context usage ratio to trigger compaction (0.7 = 70%) |
| `stopThreshold` | number | `0.4` | Target context usage ratio per compaction round (0.4 = 40%) |
| `provider` | string\|null | `null` | Provider for compaction model (null = current provider) |
| `model` | string\|null | `null` | Model ID for compaction (null = current model) |
| `compactionPromptFile` | string | `"compaction-prompt.md"` | Path to a markdown file with the compaction prompt (relative to extension dir) |

### Model Configuration

By default, tail compaction uses the **same model and provider** you're currently chatting with. To use a different (cheaper/faster) model:

```json
{
  "liveCompaction": {
    "provider": "google",
    "model": "gemini-2.5-flash"
  }
}
```

Any configured provider works — built-in (anthropic, openai, google) or custom providers registered by other extensions.

When no provider/model is set, `ctx.model` (the current active model) is used as-is.

### Compaction Prompt: Hot Context Summary

The default prompt produces a lean, **stable-sized** 4-section summary (~150-400 tokens regardless of compaction rounds). It deliberately excludes growing data (file histories, error logs, constraints).

**4 sections:**

1. **Primary Goal & User Constraints** — active goal, hard user constraints
2. **Immediate State & Active Blockers** — 1-3 active files, current blocker/error
3. **Next Logical Steps** — immediate next step + max 3 subsequent
4. **Cold Data References** — modified files not yet verified, unresolved areas

**Design principles:**

- **Stable-sized** — explicit limits (1-3 files, max 3 steps) prevent token growth across rounds
- **Consolidates, doesn't append** — merges previous summary with new content, removes stale details
- **Prompt-injection defense** — treats conversation content as untrusted data
- **Secret redaction** — `[REDACTED_<KEY_NAME>]` format, preserves key names
- **Uncertainty policy** — "UNKNOWN / NOT OBSERVED" instead of hallucinated success
- **Conflict resolution** — prefers newer evidence when merging summaries

The compaction prompt is loaded from `compaction-prompt.md` by default (via `compactionPromptFile` in `settings.json`). Edit that file directly to customize the prompt.

The prompt supports two template variables:
- `{previousSummaryBlock}` — wrapped in `<previous-summaries>` tags if present
- `{conversationText}` — the conversation messages being compacted

The prompt is sent to the compaction model in a **blank session** (no system prompt, no prior conversation) — just the compaction instructions + conversation text as a single user message.

To use a custom prompt file instead:

```json
{
  "liveCompaction": {
    "compactionPromptFile": "my-custom-prompt.md"
  }
}
```

## Compaction Notifications

When tail compaction completes, a TUI notification is shown (not injected into the conversation):

```
✦ Tail compaction: 3 turn(s) compacted, ~12,500 tokens freed (context now 42.3%)
```

Notifications use `ctx.ui.notify()` so they render immediately — even during long autonomous loops where the agent is making rapid tool calls without user input. The notification is **never added to the conversation**, so it doesn't waste the tokens we just freed.

## Commands

| Command | Description |
|---------|-------------|
| `/context-check` | Show our context % vs session's context %, compaction stats |
| `/footer-restore` | Restore pi's built-in footer (undoes our custom footer) |

## Custom Footer

The extension replaces pi's built-in footer with one that shows:
- **Line 1**: pwd + git branch (same as pi's)
- **Line 2**: token stats (↑↓RW, cost) + **our context %** + model name
- **Line 3**: extension statuses

The key difference: the context percentage is computed from `compactionState.lastCompactedTokens` (what the LLM actually sees after compaction) instead of pi's `getContextUsage()` (which reads from un-compacted session state). During the brief window after compaction but before `message_end` provides a real measurement, the footer shows `~?%`.

Use `/footer-restore` to go back to pi's built-in footer.

## Architecture

```
Session state (JSONL): Full unmodified history — never touched by us
    ↓
context event: pi rebuilds messages from session
    ↓
Our handler:
  1. Replace first N turns with accumulated summary
  2. Estimate current tokens (anchored delta: message_end baseline + growth delta)
  3. Above startThreshold? → summarize more turns with configured model
  4. Update compactedTurnCount, accumulatedSummary
  5. Return modified messages
    ↓
LLM receives: summary + remaining turns (compacted context)
    ↓
message_end: usage.input → update lastCompactedTokens (accurate baseline)
    ↓
Custom footer: shows % based on compacted messages
    ↓

If pi's auto-compaction or manual /compact fires:
  session_before_compact → reset our in-flight state
  session_compact → reset our in-flight state
  session_start → reset + reinstall footer
  (everything works normally, no conflict)
```

## Important Notes

- **No session modifications**: The JSONL file retains all original messages. No CompactionEntry is ever created.
- **pi's auto-compaction coexists**: If pi's auto-compaction fires (e.g. a massive single turn), it creates a CompactionEntry and reloads. Our state resets, we start fresh. No conflict.
- **In-flight only**: Our compaction only affects what's sent to the LLM. If you disable the extension, the full history is still there.
- **Compaction cost**: Each compaction round makes a separate LLM call with the configured model, which incurs API costs.
- **Manual /compact works normally**: If the user runs `/compact`, pi compacts the session as usual, creates a CompactionEntry, and reloads. Our in-flight state resets. Everything works exactly as before this plugin.
