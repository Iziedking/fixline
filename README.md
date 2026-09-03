# Fixline

Fixline is a repair evidence desk that belongs to the renter, not the landlord.

A browser agent works the case with you through WebMCP tools. Fixline does not give it a fixed menu. It registers the tools the current case state allows and withdraws the rest, so the agent cannot see or call a capability the record is not ready for.

No tool approves anything. The agent can only ask you.

## How the tool surface moves

`compose_request` is not registered until all four proof checks pass. `export_packet` does not exist until you have approved. While a decision sits with you, every write tool is withdrawn, so the record cannot change under the person being asked to sign it.

The proof script measures this:

| Case state | Tools registered |
| --- | ---: |
| New empty case you started | 3 |
| One fact written down | 4 |
| First source linked to it | 5 |
| Record complete | 6 |
| Draft composed | 7 |
| Waiting on your decision | 2 |
| You approved | 3 |

## Why this needs WebMCP

A server-side MCP endpoint can refuse a call. It cannot make a capability disappear from the agent's view the moment page state changes, and it cannot park a tool call on a button you are looking at.

`document.modelContext.registerTool()` with an `AbortSignal` lets the page decide what the agent is able to attempt at all. The case also stays on your machine, which matters when the contents are photos of your apartment and texts to your landlord.

## The tools

Registered on `document.modelContext` when the browser exposes it. `toolAvailability()` in `src/core.mjs` decides what is live; the browser layer only reconciles against it.

| Tool | Registered when |
| --- | --- |
| `get_case_snapshot` | Always. Returns proof gaps and the currently live tool list. |
| `get_evidence_item` | At least one source record has been linked. |
| `capture_fact` | The case is open and no decision is pending. |
| `attach_evidence` | At least one fact exists for a source to point at. |
| `set_urgency` | The case is open and no decision is pending. |
| `compose_request` | Every proof check passes. |
| `request_human_approval` | A draft exists and no decision is pending. Blocks until you click. |
| `export_packet` | You approved. |

## Sources have to point at something

A source record that backs up nothing proves nothing, so `attach_evidence` refuses an empty fact list and names any fact id that is not in the case. That is also why the tool stays unregistered until you have written down at least one fact: on an empty record there is nothing for a photo to be evidence of.

The agent can add a source you describe to it. It cannot add the photo. Image bytes only enter through your own file picker, which downscales the picture in your browser and keeps it in local storage. Nothing is uploaded, and the tool the agent sees has no field for image data at all.

## The approval handshake

`request_human_approval` is the one tool that does not return right away.

1. The agent calls it with a short note saying what it changed.
2. A decision card appears in the page and follows you across every route.
3. The tool call parks. The agent is now waiting on a person.
4. You press Approve or Decline.
5. Your decision goes back to the agent as the tool result, and the surface re-registers.

Declining does something real. The draft stays unapproved, export stays unregistered, and the record reopens for edits. The spec does not define whether `execute()` may stay pending while waiting on a person, so the park is capped at 45 seconds to stay under a typical client timeout. If it expires the call returns `no_response`, the decision card stays on screen, and the agent is told to poll `get_case_snapshot` for the outcome rather than ask again. If the agent aborts the call, the pending decision is withdrawn.

## Run it

Node.js 22 or newer. No dependencies.

```bash
npm run proof   # deterministic proof of the state machine
npm run serve   # static server on http://127.0.0.1:4173
```

The site opens on a seeded sample case. "Start a new case" on `/case` gives you an empty record with your own address and issue, which is the smallest surface Fixline registers: read the case, add a fact, set urgency. Nothing to link, read, draft, or approve yet. Write one fact and a fourth tool appears; link a photo to it and a fifth does.

Open `http://127.0.0.1:4173` in Chrome with WebMCP enabled, or in the ChatGPT in-app browser. Opening `index.html` directly will not work, because Chrome blocks module scripts on `file://`.

To watch the surface change, run `document.modelContext.getTools()` in DevTools before and after each step. `window.fixline.availableTools()` returns the same list.

If the browser has no WebMCP, the page labels itself Preview mode and runs the same handlers behind visible buttons under the same gates. The "Run the agent path" button on `/activity` replays the whole sequence, including both gate hits.

## Proof

`npm run proof` replays the core against `fixtures/repair-case.json` and asserts the claims above:

- an empty case registers three tools, with no evidence read and no drafting
- a source cannot be linked to a case with no facts, and the gate says why
- an unknown fact id is named back to the caller and refused
- a source that backs up nothing is refused
- the agent tool cannot claim an image it did not add
- one fact unlocks linking a source, and one source unlocks reading evidence back
- the seeded case withholds drafting, approval, and export
- composing an incomplete record is gated, and the gate names the missing check
- completing the record registers drafting, while drafting alone does not register export
- no approval tool is ever exposed to the agent
- asking for a decision freezes every write tool
- declining leaves the draft unapproved and reopens the record
- only your decision approves, and only then does `export_packet` exist
- every evidence id cited in the draft resolves to a real record

The output carries a SHA-256 digest over the full step and surface trace.

## Routes

- `/case` builds the dated repair record
- `/evidence` shows source records and the facts they support
- `/draft` is where you read the request and decide
- `/activity` shows the live tool surface and every action receipt

## Architecture

`src/core.mjs` is a pure state machine with no DOM or network dependency. `toolAvailability()` there is the only place that decides what may be called.

`src/app.mjs` is the only browser layer. It renders the desk and reconciles the registered WebMCP surface against the core after every state change.

`scripts/proof.mjs` is a second consumer of the same core, which is why the proof can assert the browser's behavior without a browser.

Static site, no build step, no runtime dependencies. It deploys to any static host.

## What this does not do

- Cases live in this browser's `localStorage`, seeded from a sample fixture. There is no server, account, or database, and nothing syncs between devices.
- Photos stay in this browser. They are downscaled locally, never uploaded, and never analysed.
- The draft is not legal advice and does not establish that anything you entered is true.
- There is no diagnosis and no emergency triage.
- Nothing is sent to anyone. Approving produces a local timestamped packet and that is all.

## License

MIT. Copyright (c) 2026 Fixline contributors. The full text is in [LICENSE](LICENSE).

You can use, copy, modify, and distribute this, including commercially, as long as the copyright notice and permission notice stay with it. It comes with no warranty.
