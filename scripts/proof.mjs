import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  availableToolNames,
  createCase,
  newCase,
  dispatchTool,
  packetFor,
  resolveApproval,
  snapshot,
  stableJson
} from "../src/core.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/repair-case.json", import.meta.url), "utf8"));
const at = (n) => `2026-09-03T12:00:0${n}.000Z`;

function assert(condition, message) {
  if (!condition) throw new Error(`Proof failed: ${message}`);
}

/** Calls a tool and returns whether the state machine allowed it. */
function attempt(caseData, name, input, time) {
  try {
    return { allowed: true, result: dispatchTool(caseData, name, input, time) };
  } catch (error) {
    return { allowed: false, gated: Boolean(error.gated), message: error.message };
  }
}

let caseData = createCase(fixture);
const surfaces = [];
const steps = [];

function recordSurface(label) {
  const tools = availableToolNames(caseData);
  surfaces.push({ label, tools });
  return tools;
}

function step(name, input, time) {
  const outcome = attempt(caseData, name, input, time);
  assert(outcome.allowed, `${name} should be available: ${outcome.message}`);
  caseData = outcome.result.caseData;
  steps.push({ name, receipt: caseData.receipts.at(-1) || null });
  return outcome.result;
}

/* 0. An empty case a renter starts themselves exposes the smallest surface. */
const blank = newCase({ title: "Bathroom radiator cold", location: "Elm House / Flat 2", startedOn: "2026-09-01" }, at(0));
const blankTools = availableToolNames(blank);
assert(blankTools.length === 3, "an empty case registers only three tools");
assert(!blankTools.includes("get_evidence_item"), "no evidence tool without evidence records");
assert(!blankTools.includes("compose_request"), "an empty record cannot be drafted");
surfaces.push({ label: "new empty case", tools: blankTools });

/* 1. The opening surface withholds everything the record is not ready for. */
const opening = recordSurface("initial");
assert(opening.includes("get_case_snapshot"), "reading the case is always allowed");
assert(!opening.includes("compose_request"), "drafting is withheld while proof checks are open");
assert(!opening.includes("request_human_approval"), "approval cannot be requested without a draft");
assert(!opening.includes("export_packet"), "export is withheld before any human decision");

const inspected = dispatchTool(caseData, "get_case_snapshot", {}, at(0));
assert(inspected.output.readiness.ready === false, "the fixture starts with a known proof gap");
steps.push({ name: "get_case_snapshot", receipt: null });

/* 2. Evidence reads resolve, and unknown ids fail without mutating the case. */
const evidenceRead = dispatchTool(caseData, "get_evidence_item", { evidenceId: "evidence-photo" }, at(0));
assert(evidenceRead.output.id === "evidence-photo", "evidence lookup returns the requested record");
assert(evidenceRead.output.factIds.includes("fact-what"), "evidence lookup preserves linked fact ids");
steps.push({ name: "get_evidence_item", receipt: null });

const missing = attempt(caseData, "get_evidence_item", { evidenceId: "evidence-missing" }, at(0));
assert(!missing.allowed && missing.message.includes("was not found"), "unknown evidence ids fail safely");

/* 3. Drafting an incomplete record is refused by the surface, not by a message. */
const earlyDraft = attempt(caseData, "compose_request", {}, at(1));
assert(!earlyDraft.allowed && earlyDraft.gated, "composing before the record is complete is gated");
assert(earlyDraft.message.includes("Entry preference"), "the gate names the missing proof check");

/* 4. Completing the record registers the drafting capability. */
step("capture_fact", { label: "Entry preference", text: "Please coordinate entry after 5 p.m. on weekdays.", occurredOn: "2026-08-24" }, at(1));
step("set_urgency", { level: "soon" }, at(2));
const complete = recordSurface("record complete");
assert(complete.includes("compose_request"), "a complete record unlocks drafting");
assert(!complete.includes("export_packet"), "a complete record still does not unlock export");

step("compose_request", {}, at(3));
assert(caseData.draft?.status === "needs_approval", "a fresh draft needs approval");
const drafted = recordSurface("drafted");
assert(drafted.includes("request_human_approval"), "a draft unlocks asking the renter");
assert(!drafted.includes("export_packet"), "a draft alone does not unlock export");

/* 5. There is no tool that approves. The agent can only ask. */
assert(
  !availableToolNames(caseData).includes("approve_request"),
  "no approval tool is ever exposed to the agent"
);
const exportBeforeDecision = attempt(caseData, "export_packet", {}, at(4));
assert(!exportBeforeDecision.allowed && exportBeforeDecision.gated, "export is gated before a human decides");

/* 6. Asking parks the case on the renter and withdraws every write tool. */
step("request_human_approval", { note: "Approve to unlock the export." }, at(4));
assert(caseData.pendingApproval, "asking opens a pending decision");
assert(caseData.receipts.at(-1)?.result === "pending", "asking records a pending receipt");
const waiting = recordSurface("waiting on the renter");
assert(!waiting.includes("capture_fact"), "the record is frozen while the renter decides");
assert(!waiting.includes("compose_request"), "the draft cannot change under the renter");
assert(!waiting.includes("request_human_approval"), "the renter cannot be asked twice at once");
assert(caseData.draft.status === "needs_approval", "asking does not approve anything");

/* 7. Declining is a real outcome, not a dead end. */
const declined = resolveApproval(caseData, "declined", at(5));
assert(declined.draft.status === "needs_approval", "a decline leaves the draft unapproved");
assert(!availableToolNames(declined).includes("export_packet"), "a decline does not unlock export");
assert(availableToolNames(declined).includes("capture_fact"), "a decline reopens the record for edits");

/* 8. Only the human decision approves, and only then does export exist. */
const approved = resolveApproval(caseData, "approved", at(5));
assert(approved.draft.status === "approved", "the renter's decision approves the draft");
assert(approved.receipts.at(-1)?.result === "ok", "the decision leaves a receipt");
const final = availableToolNames(approved);
assert(final.includes("export_packet"), "approval registers the export tool");
assert(!final.includes("capture_fact"), "the approved record is locked");
assert(
  approved.draft.evidenceIds.every((id) => approved.evidence.some((item) => item.id === id)),
  "every cited evidence id resolves to a record"
);
surfaces.push({ label: "approved", tools: final });

const packet = JSON.parse(packetFor(approved));
assert(packet.case.draft.status === "approved", "the exported packet carries the approved draft");

const proof = {
  product: "Fixline",
  generatedAt: "2026-09-03",
  fixture: "fixtures/repair-case.json",
  steps,
  surfaces,
  gates: [earlyDraft.message, exportBeforeDecision.message],
  finalStatus: approved.draft.status,
  finalReadiness: snapshot(approved).readiness
};
const digest = createHash("sha256").update(stableJson(proof)).digest("hex");

console.log(JSON.stringify({
  level: "info",
  event: "fixline_proof_passed",
  steps: proof.steps.length,
  surfaceTransitions: surfaces.map((surface) => `${surface.label}:${surface.tools.length}`),
  gatedCalls: proof.gates.length,
  approvalToolExposedToAgent: false,
  finalStatus: proof.finalStatus,
  readiness: `${proof.finalReadiness.complete}/${proof.finalReadiness.total}`,
  provenance: { fixture: proof.fixture, generatedAt: proof.generatedAt, sha256: digest }
}, null, 2));
