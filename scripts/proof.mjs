import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dispatchTool, snapshot, stableJson, createCase, approveByHuman } from "../src/core.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/repair-case.json", import.meta.url), "utf8"));
const fixedTimes = [
  "2026-09-03T12:00:01.000Z",
  "2026-09-03T12:00:02.000Z",
  "2026-09-03T12:00:03.000Z",
  "2026-09-03T12:00:04.000Z",
  "2026-09-03T12:00:05.000Z",
  "2026-09-03T12:00:06.000Z"
];

function assert(condition, message) {
  if (!condition) throw new Error(`Proof failed: ${message}`);
}

let caseData = createCase(fixture);
const steps = [];
function step(name, input, at) {
  const result = dispatchTool(caseData, name, input, at);
  caseData = result.caseData;
  steps.push({ name, output: result.output, receipt: caseData.receipts.at(-1) || null });
}

const inspected = dispatchTool(caseData, "get_case_snapshot", {}, fixedTimes[0]);
assert(inspected.output.readiness.ready === false, "fixture starts with a known proof gap");
steps.push({ name: "get_case_snapshot", output: "Snapshot read", receipt: null });
const evidenceRead = dispatchTool(caseData, "get_evidence_item", { evidenceId: "evidence-photo" }, fixedTimes[0]);
assert(evidenceRead.output.id === "evidence-photo", "evidence lookup returns the requested record");
assert(evidenceRead.output.factIds.includes("fact-what"), "evidence lookup preserves linked fact ids");
steps.push({ name: "get_evidence_item", output: "Evidence record read", receipt: null });
let missingEvidenceRejected = false;
try {
  dispatchTool(caseData, "get_evidence_item", { evidenceId: "evidence-missing" }, fixedTimes[0]);
} catch (error) {
  missingEvidenceRejected = error instanceof Error && error.message.includes("was not found");
}
assert(missingEvidenceRejected, "unknown evidence ids fail safely");
step("capture_fact", { label: "Entry preference", text: "Please coordinate entry after 5 p.m. on weekdays.", occurredOn: "2026-08-24" }, fixedTimes[1]);
step("set_urgency", { level: "soon" }, fixedTimes[2]);
step("compose_request", {}, fixedTimes[3]);
step("approve_request", {}, fixedTimes[4]);

assert(caseData.draft?.status === "needs_approval", "agent approval attempt does not approve the draft");
assert(caseData.receipts.at(-1)?.result === "refused", "approval attempt creates a refusal receipt");
const approved = approveByHuman(caseData, fixedTimes[5]);
assert(approved.draft?.status === "approved", "human approval changes the draft state");
assert(approved.receipts.at(-1)?.result === "ok", "human approval creates a receipt");
assert(approved.draft.evidenceIds.every((id) => approved.evidence.some((item) => item.id === id)), "draft evidence ids resolve to evidence");

const proof = {
  product: "Fixline",
  generatedAt: "2026-09-03",
  fixture: "fixtures/repair-case.json",
  steps,
  evidenceId: evidenceRead.output.id,
  refusal: caseData.receipts.find((receipt) => receipt.result === "refused")?.detail,
  finalStatus: approved.draft.status,
  finalReadiness: snapshot(approved).readiness
};
const digest = createHash("sha256").update(stableJson(proof)).digest("hex");

console.log(JSON.stringify({
  level: "info",
  event: "fixline_proof_passed",
  steps: proof.steps.length,
  refusal: proof.refusal,
  finalStatus: proof.finalStatus,
  readiness: `${proof.finalReadiness.complete}/${proof.finalReadiness.total}`,
  provenance: { fixture: proof.fixture, generatedAt: proof.generatedAt, sha256: digest }
}, null, 2));
