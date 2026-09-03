# Fixline

Keep the record. Keep the human in charge.

Fixline helps renters keep repair details in one dated record. A browser agent can read and organize that record through WebMCP tools, but the renter approves the request before it becomes an exportable local packet.

## Why this exists

Rental portals already handle maintenance forms, photos, status tracking, triage, and vendor workflows. Fixline stays with the renter: it keeps the evidence timeline portable, links each request detail to a source, and leaves approval in the renter's hands.

## Run locally

Requirements: Node.js 22 or newer.

```text
npm run proof
npm run serve
```

Open `http://127.0.0.1:4173`.

Do not double-click `index.html` as the normal launch path. Chrome blocks module scripts opened from `file://`, which leaves a static page unable to load its case data. From the project folder, double-click `start-fixline.cmd`, or run `npm run serve` and open the local address above.

The page uses a fixture and browser memory only. It has no keys, database, account system, or network API. When WebMCP is unavailable, the page labels itself Preview mode and runs the same tool handlers through visible buttons.

## Product routes

The landing page is intentionally a simple entry point. The navbar keeps each job separate:

- `/case`: build the dated repair record
- `/evidence`: inspect source records and linked facts
- `/draft`: compose, approve, and export the local request packet
- `/activity`: inspect the WebMCP tools and action receipts

The local server and `vercel.json` both fall back to `index.html` so these routes also work when opened directly.

## WebMCP tools

The page registers these tools when `document.modelContext` is available:

- `get_case_snapshot`: read the active case and proof gaps
- `get_evidence_item`: retrieve one evidence record by id with its linked fact ids
- `capture_fact`: add a dated renter-provided fact
- `set_urgency`: set routine, soon, or urgent without diagnosing the issue
- `compose_request`: create a draft with evidence ids
- `approve_request`: intentionally refuse because human approval is required

The visible `Approve draft` button is the only path that marks a draft approved. The MVP does not send a message to a landlord.

## Proof

`npm run proof` runs the real deterministic core against `fixtures/repair-case.json`. It verifies the evidence lookup, safe rejection of an unknown evidence id, four successful state changes, the refusal branch, evidence references, and the human approval transition. The output includes a SHA-256 provenance digest.

## Deploy

This is a static site. Upload the repository root to any static host and preserve the relative `fixtures/` and `src/` paths.

Vercel CLI is not installed in this workspace. If you want the CLI path, install it with `npm i -g vercel`, then run `vercel login` and `vercel --prod` from the repository root. The Vercel dashboard or another static host is a valid fallback.

## Truthful limits

- Sample case data is fixture-backed and local-only.
- No photo bytes are uploaded or analyzed.
- The draft is not legal advice and does not establish the truth of user-entered facts.
- No emergency diagnosis or triage is provided.
- No outbound communication, landlord portal integration, account, or cloud persistence exists in the MVP.

## Hackathon materials

- [HACKATHON_RESEARCH.md](HACKATHON_RESEARCH.md): dated differentiation research and proof contract.
- [PLAN.md](PLAN.md): locked build decisions and release gates.
- [UI_BRIEF.md](UI_BRIEF.md): intent-led interface brief.
- [BRAND.md](BRAND.md): product identity and tokens.
- [RUNBOOK.md](RUNBOOK.md): local and live demo checklist.

## License

MIT. See [LICENSE](LICENSE).

The WebMCP contract follows the official resource guidance: tools are narrow, annotated, bounded, and backed by a deterministic proof path. See `HACKATHON_RESEARCH.md` for the resource links and product boundary.
