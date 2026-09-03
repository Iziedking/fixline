const URGENCY_LEVELS = ["routine", "soon", "urgent"];
const FACT_LABELS = ["Issue", "Location", "First contact", "Entry preference", "Update"];
const EVIDENCE_KINDS = ["photo", "message", "receipt", "note"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertString(value, field, maxLength = 240) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string under ${maxLength} characters.`);
  }
  return value.trim();
}

function assertDate(value, field) {
  const date = assertString(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  return date;
}

function assertCase(caseData) {
  assertString(caseData.id, "case id", 48);
  assertString(caseData.title, "case title", 120);
  assertString(caseData.location, "case location", 120);
  assertDate(caseData.startedOn, "startedOn");
  if (!URGENCY_LEVELS.includes(caseData.urgency)) {
    throw new Error("urgency must be routine, soon, or urgent.");
  }
  if (!Array.isArray(caseData.facts) || !Array.isArray(caseData.evidence) || !Array.isArray(caseData.receipts)) {
    throw new Error("case collections are invalid.");
  }
  return clone(caseData);
}

function makeReceipt(action, result, detail, now) {
  return {
    id: `receipt-${now}-${action}`,
    action,
    result,
    at: now,
    detail
  };
}

function withReceipt(caseData, receipt) {
  const next = clone(caseData);
  next.receipts.push(receipt);
  return next;
}

function readinessFor(caseData) {
  const labels = new Set(caseData.facts.map((fact) => fact.label));
  const checks = [
    { id: "issue", label: "Issue described", complete: labels.has("Issue") },
    { id: "location", label: "Location named", complete: labels.has("Location") },
    { id: "timeline", label: "First contact dated", complete: labels.has("First contact") },
    { id: "entry", label: "Entry preference added", complete: labels.has("Entry preference") }
  ];
  const complete = checks.filter((check) => check.complete).length;
  return {
    checks,
    complete,
    total: checks.length,
    ready: complete === checks.length,
    label: complete === checks.length ? "Ready for your review" : `${complete} of ${checks.length} proof checks complete`
  };
}

function draftFor(caseData) {
  const readiness = readinessFor(caseData);
  const evidenceIds = caseData.evidence.map((item) => item.id);
  const factLines = caseData.facts
    .map((fact) => `- ${fact.label}: ${fact.text} [${fact.id}]`)
    .join("\n");
  const nextLine = readiness.ready
    ? "Please confirm a time for access so the issue can be inspected."
    : "Please confirm receipt and let me know the next step. I can add an entry preference before sending.";
  return {
    subject: `Repair request: ${caseData.title}`,
    body: `Hello,\n\nI am reporting the following issue at ${caseData.location}:\n${factLines}\n\n${nextLine}\n\nThis request was prepared in Fixline for my review.`,
    evidenceIds,
    status: "needs_approval"
  };
}

/**
 * The tool surface is a function of case state, not a fixed list.
 *
 * This is the product's safety model. A capability the case is not ready for is
 * not registered with the browser, so an agent cannot call it, cannot see it,
 * and cannot argue its way past it. `export_packet` only exists after a human
 * has approved, which means no agent path reaches an export without a person.
 */
export function toolAvailability(caseData) {
  const safeCase = assertCase(caseData);
  const readiness = readinessFor(safeCase);
  const hasDraft = Boolean(safeCase.draft);
  const approved = safeCase.draft?.status === "approved";
  const pending = Boolean(safeCase.pendingApproval);
  return {
    get_case_snapshot: {
      available: true,
      reason: "The case can always be read."
    },
    get_evidence_item: {
      available: safeCase.evidence.length > 0,
      reason: safeCase.evidence.length > 0 ? "Evidence records exist." : "No evidence records in this case."
    },
    capture_fact: {
      available: !approved && !pending,
      reason: approved ? "The record is locked after approval." : pending ? "A decision is with the renter." : "The case is open for new dated facts."
    },
    attach_evidence: {
      available: safeCase.facts.length > 0 && !approved && !pending,
      reason: approved
        ? "The record is locked after approval."
        : pending
          ? "A decision is with the renter."
          : safeCase.facts.length > 0
            ? "There are facts a source record can support."
            : "Add a fact first. A source record has to point at something."
    },
    set_urgency: {
      available: !approved && !pending,
      reason: approved ? "The record is locked after approval." : pending ? "A decision is with the renter." : "Urgency can still change."
    },
    compose_request: {
      available: readiness.ready && !approved && !pending,
      reason: approved
        ? "The request is already approved."
        : pending
          ? "A decision is with the renter."
          : readiness.ready
            ? "Every proof check is complete."
            : `Blocked until every proof check passes. Missing: ${readiness.checks.filter((check) => !check.complete).map((check) => check.label).join(", ")}.`
    },
    request_human_approval: {
      available: hasDraft && !approved && !pending,
      reason: !hasDraft
        ? "There is no draft to put in front of the renter."
        : approved
          ? "The renter already approved this draft."
          : pending
            ? "A request is already waiting on the renter."
            : "A draft is ready to send to the renter for a decision."
    },
    export_packet: {
      available: approved,
      reason: approved ? "The renter approved this packet." : "Only a renter-approved packet can be exported."
    }
  };
}

export function availableToolNames(caseData) {
  const availability = toolAvailability(caseData);
  return Object.keys(availability).filter((name) => availability[name].available);
}

/**
 * Starts an empty case the renter defines themselves.
 *
 * An empty record exposes the smallest surface Fixline ever registers: read the
 * case, add a fact, set urgency. There is no evidence to read, nothing to draft,
 * and nothing to approve, so those tools do not exist yet.
 */
export function newCase(input, now) {
  const title = assertString(input?.title, "title", 120);
  const location = assertString(input?.location, "location", 120);
  const startedOn = assertDate(input?.startedOn, "startedOn");
  const stamp = String(now).replace(/[^0-9]/g, "").slice(0, 14);
  const created = assertCase({
    id: `FIX-${stamp}`,
    title,
    location,
    startedOn,
    category: "unspecified",
    urgency: "routine",
    facts: [],
    evidence: [],
    draft: null,
    pendingApproval: null,
    receipts: []
  });
  return withReceipt(created, makeReceipt("new_case", "ok", `Started a new case: ${title}`, now));
}

export function createCase(caseData) {
  return assertCase(caseData);
}

export function snapshot(caseData) {
  const safeCase = assertCase(caseData);
  const readiness = readinessFor(safeCase);
  return {
    id: safeCase.id,
    title: safeCase.title,
    location: safeCase.location,
    startedOn: safeCase.startedOn,
    category: safeCase.category,
    urgency: safeCase.urgency,
    facts: clone(safeCase.facts),
    evidence: clone(safeCase.evidence),
    draft: clone(safeCase.draft),
    pendingApproval: clone(safeCase.pendingApproval || null),
    readiness,
    receipts: clone(safeCase.receipts),
    availableTools: availableToolNames(safeCase)
  };
}

export function getEvidenceItem(caseData, input) {
  const safeCase = assertCase(caseData);
  const evidenceId = assertString(input?.evidenceId, "evidence id", 64);
  const item = safeCase.evidence.find((evidence) => evidence.id === evidenceId);
  if (!item) {
    throw new Error(`Evidence item ${evidenceId} was not found in the active case.`);
  }
  return clone(item);
}

export function captureFact(caseData, input, now) {
  const safeCase = assertCase(caseData);
  const label = assertString(input?.label, "label", 40);
  const text = assertString(input?.text, "text", 280);
  const occurredOn = assertDate(input?.occurredOn, "occurredOn");
  if (!FACT_LABELS.includes(label)) {
    throw new Error(`label must be one of: ${FACT_LABELS.join(", ")}.`);
  }
  const next = clone(safeCase);
  const fact = {
    id: `fact-${next.facts.length + 1}`,
    label,
    text,
    occurredOn,
    source: "user"
  };
  next.facts.push(fact);
  return withReceipt(next, makeReceipt("capture_fact", "ok", `${fact.id} added`, now));
}

/**
 * Links a source record to the facts it backs up.
 *
 * A source that points at nothing proves nothing, so this refuses an empty or
 * unknown fact list. Image bytes never pass through here: only the renter's own
 * file picker can set `hasImage`, which keeps the agent able to describe a
 * source without being able to manufacture one.
 */
export function attachEvidence(caseData, input, now) {
  const safeCase = assertCase(caseData);
  const label = assertString(input?.label, "label", 80);
  const kind = assertString(input?.kind, "kind", 12);
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${EVIDENCE_KINDS.join(", ")}.`);
  }
  const capturedOn = assertDate(input?.capturedOn, "capturedOn");
  const factIds = Array.isArray(input?.factIds) ? input.factIds.filter(Boolean) : [];
  if (factIds.length === 0) {
    throw new Error("A source record must support at least one fact. Pass the ids of the facts it backs up.");
  }
  const known = new Set(safeCase.facts.map((fact) => fact.id));
  const unknown = factIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`These fact ids are not in this case: ${unknown.join(", ")}.`);
  }
  const next = clone(safeCase);
  const item = {
    id: `evidence-${next.evidence.length + 1}`,
    kind,
    label,
    capturedOn,
    factIds: Array.from(new Set(factIds)),
    hasImage: input?.hasImage === true
  };
  next.evidence.push(item);
  const detail = `${item.id} supports ${item.factIds.join(", ")}${item.hasImage ? " with an image" : ""}`;
  return withReceipt(next, makeReceipt("attach_evidence", "ok", detail, now));
}

export function setUrgency(caseData, input, now) {
  const safeCase = assertCase(caseData);
  const level = assertString(input?.level, "level", 12);
  if (!URGENCY_LEVELS.includes(level)) {
    throw new Error("level must be routine, soon, or urgent.");
  }
  const next = clone(safeCase);
  next.urgency = level;
  return withReceipt(next, makeReceipt("set_urgency", "ok", `Urgency set to ${level}`, now));
}

export function composeRequest(caseData, now) {
  const safeCase = assertCase(caseData);
  const next = clone(safeCase);
  next.draft = draftFor(next);
  return withReceipt(next, makeReceipt("compose_request", "ok", "Draft created with evidence ids", now));
}

/**
 * The agent asks. It does not decide.
 *
 * This opens a decision that only the visible renter control can close. The
 * calling agent is left waiting on a real person, which is the whole point of
 * putting the tool in the page instead of on a server.
 */
export function requestHumanApproval(caseData, input, now) {
  const safeCase = assertCase(caseData);
  if (!safeCase.draft) {
    throw new Error("There is no draft to put in front of the renter.");
  }
  if (safeCase.draft.status === "approved") {
    throw new Error("The renter already approved this draft.");
  }
  if (safeCase.pendingApproval) {
    throw new Error("A request is already waiting on the renter.");
  }
  const note = input?.note ? assertString(input.note, "note", 200) : "The agent asked the renter to review this draft.";
  const next = clone(safeCase);
  next.pendingApproval = {
    id: `approval-${now}`,
    requestedAt: now,
    note
  };
  return withReceipt(next, makeReceipt("request_human_approval", "pending", `Waiting on the renter: ${note}`, now));
}

/**
 * Closes a pending decision. Only ever called from a visible renter control.
 */
export function resolveApproval(caseData, decision, now) {
  const safeCase = assertCase(caseData);
  if (!safeCase.pendingApproval) {
    throw new Error("There is no decision waiting on the renter.");
  }
  if (decision !== "approved" && decision !== "declined") {
    throw new Error("decision must be approved or declined.");
  }
  const next = clone(safeCase);
  const note = next.pendingApproval.note;
  next.pendingApproval = null;
  if (decision === "approved") {
    next.draft.status = "approved";
    return withReceipt(next, makeReceipt("human_decision", "ok", "The renter approved the draft. No message was sent.", now));
  }
  return withReceipt(next, makeReceipt("human_decision", "declined", `The renter declined. ${note}`, now));
}

export function approveByHuman(caseData, now) {
  const safeCase = assertCase(caseData);
  if (!safeCase.draft) {
    throw new Error("Create a draft before approving it.");
  }
  const next = clone(safeCase);
  next.pendingApproval = null;
  next.draft.status = "approved";
  return withReceipt(next, makeReceipt("human_approval", "ok", "Draft approved locally. No message was sent.", now));
}

export function packetFor(caseData) {
  const safeCase = assertCase(caseData);
  if (safeCase.draft?.status !== "approved") {
    throw new Error("Only a renter-approved packet can be exported.");
  }
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    product: "Fixline",
    capability: "local-only sample packet",
    case: snapshot(safeCase)
  }, null, 2);
}

export function dispatchTool(caseData, name, input, now) {
  const availability = toolAvailability(caseData);
  const entry = availability[name];
  if (!entry) {
    throw new Error(`Unknown WebMCP tool: ${name}.`);
  }
  if (!entry.available) {
    const error = new Error(`${name} is not available in the current case state. ${entry.reason}`);
    error.gated = true;
    throw error;
  }
  switch (name) {
    case "get_case_snapshot":
      return { caseData: assertCase(caseData), output: snapshot(caseData) };
    case "get_evidence_item":
      return { caseData: assertCase(caseData), output: getEvidenceItem(caseData, input) };
    case "capture_fact":
      return { caseData: captureFact(caseData, input, now), output: "Fact captured in the case timeline." };
    case "attach_evidence":
      // hasImage is forced off here. Only the renter's file picker adds bytes.
      return { caseData: attachEvidence(caseData, { ...input, hasImage: false }, now), output: "Source record linked to the facts it supports." };
    case "set_urgency":
      return { caseData: setUrgency(caseData, input, now), output: "Urgency updated in the case." };
    case "compose_request":
      return { caseData: composeRequest(caseData, now), output: "Draft created with evidence references." };
    case "request_human_approval":
      return { caseData: requestHumanApproval(caseData, input, now), output: "Waiting for the renter's decision." };
    case "export_packet":
      return { caseData: assertCase(caseData), output: packetFor(caseData) };
    default:
      throw new Error(`Unknown WebMCP tool: ${name}.`);
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export { URGENCY_LEVELS, FACT_LABELS, EVIDENCE_KINDS };
