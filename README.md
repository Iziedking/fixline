# Fixline

**The tool surface is the safety model.**

Fixline is a renter-owned repair evidence desk. A browser agent works the case alongside the renter through WebMCP tools — but Fixline does not hand the agent a fixed menu. It registers exactly the tools the current case state allows and withdraws the rest, so a capability the record is not ready for cannot be called, cannot be seen, and cannot be argued past.

There is no tool that approves anything. The agent can only ask.

## The idea

Most agent integrations enforce boundaries with a refusal: the agent calls `send_email`, the server says no. That is a string, and a judge cannot tell it apart from a hardcoded `return "denied"`.

Fixline enforces boundaries with registration. `compose_request` does not exist until every proof check passes. `export_packet` does not exist until a human has approved. `request_human_approval` blocks on a real person and returns their actual decision to the waiting agent.

Watch the surface move as the case progresses:

| Case state | Tools registered |
| --- | ---: |
| Fresh case, proof checks open | 4 |
| Record complete | 5 |
| Draft composed | 6 |
| **Waiting on the renter's decision** | **2** |
| Renter approved | 3 |

When the agent asks for a decision, every write tool is withdrawn. The record cannot shift under the person who is being asked to sign off on it.

## Why WebMCP

This only works in the page. A server-side MCP endpoint can refuse a call, but it cannot make a capability disappear from the agent's view at the moment the page state changes, and it cannot park a tool call on a button a human is looking at. `document.modelContext.registerTool()` with an `AbortSignal` gives the page authority over what the agent is even able to attempt, and it keeps the renter's case entirely on the renter's machine.

## The tools

Registered on `document.modelContext` when available. Availability is computed by the state machine in `src/core.mjs`, not hardcoded here.

| Tool | Registered when |
| --- | --- |
| `get_case_snapshot` | Always. Returns proof gaps and the currently live tool list. |
| `get_evidence_item` | Evidence records exist. |
| `capture_fact` | The case is open and no decision is pending. |
| `set_urgency` | The case is open and no decision is pending. |
| `compose_request` | **Every proof check passes.** |
| `request_human_approval` | A draft exists and no decision is pending. **Blocks until the renter clicks.** |
| `export_packet` | **The renter approved.** |

## The approval handshake

`request_human_approval` is the only tool that does not return immediately:

1. The agent calls it with a short note explaining what it changed.
2. A decision card appears in the page and follows the renter across every route.
3. The tool call parks. The agent is waiting on a person.
4. The renter presses Approve or Decline.
5. Their decision returns to the agent as the tool result, and the surface re-registers.

A decline is a real outcome: the draft stays unapproved, export stays unregistered, and the record reopens for edits. If nobody answers within three minutes the call resolves as `no_response` rather than hanging forever, and if the agent aborts the call the pending decision is withdrawn.

## Run it

Requires Node.js 22 or newer. No dependencies.

```bash
npm run proof   # deterministic proof of the state machine
npm run serve   # static server on http://127.0.0.1:4173
```

Open `http://127.0.0.1:4173` in Chrome with WebMCP enabled, or in the ChatGPT in-app browser. Do not open `index.html` directly — Chrome blocks module scripts on `file://`.

To watch the surface change, open DevTools and run `document.modelContext.getTools()` before and after each step. `window.fixline.availableTools()` reports the same list.

Without WebMCP the page labels itself **Preview mode** and runs the identical handlers behind visible buttons, gated by the identical rules. The **Run the agent path** button on `/activity` replays the full sequence including both gate hits.

## Proof

`npm run proof` replays the real core against `fixtures/repair-case.json` and asserts the claims this README makes:

- the opening surface withholds drafting, approval, and export
- composing an incomplete record is gated, and the gate names the missing check
- completing the record registers drafting; drafting alone does not register export
- **no approval tool is ever exposed to the agent**
- asking for a decision freezes every write tool
- declining leaves the draft unapproved and reopens the record
- only the human decision approves, and only then does `export_packet` exist
- every evidence id cited in the draft resolves to a real record

Output includes a SHA-256 digest over the full step and surface trace.

## Routes

- `/case` — build the dated repair record
- `/evidence` — inspect source records and the facts they support
- `/draft` — read the request and make the call
- `/activity` — the live tool surface and every action receipt

## Architecture

`src/core.mjs` is a pure state machine with no DOM or network dependency; `toolAvailability()` is the single source of truth for what may be called. `src/app.mjs` is the only browser layer — it renders the desk and reconciles the registered WebMCP surface against the core on every state change. `scripts/proof.mjs` is a second consumer of the same core.

Static site, no runtime dependencies, no build step. Deploys to any static host.

## Truthful limits

- The case is fixture-seeded sample data and persists only in this browser's `localStorage`. No server, account, or database exists.
- No photo bytes are uploaded or analyzed; evidence records are metadata.
- The draft is not legal advice and does not establish that any user-entered fact is true.
- No diagnosis or emergency triage is provided.
- **No outbound communication exists.** Approval produces a local, timestamped packet. Nothing is sent to a landlord.

## License

MIT. See [LICENSE](LICENSE).
