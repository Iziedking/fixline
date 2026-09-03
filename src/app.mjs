import {
  approveByHuman,
  availableToolNames,
  createCase,
  dispatchTool,
  newCase,
  packetFor,
  resolveApproval,
  snapshot,
  toolAvailability
} from "./core.mjs";

const app = document.querySelector("#app");
const badge = document.querySelector("#capability-badge");
const STORAGE_KEY = "fixline.case.v2";
// Kept under a typical agent-client tool timeout. If the park is cut short, the
// decision card stays up and the agent can poll get_case_snapshot for the result.
const APPROVAL_TIMEOUT_MS = 45000;

/**
 * One definition per tool. `available` is decided by the core state machine, so
 * this list is a catalogue rather than the live surface. The live surface is
 * whatever is registered with the browser at this instant.
 */
const TOOL_DEFS = [
  {
    name: "get_case_snapshot",
    title: "Read repair case",
    summary: "Read the case, the proof gaps, and which tools are live right now.",
    description: "Read the active renter repair case: facts, evidence ids, proof-check gaps, draft status, and the list of tools currently available in this page state. The available tool list changes as the case progresses, so call this first and again after any change to see which tools have unlocked.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
    name: "get_evidence_item",
    title: "Read evidence item",
    summary: "Retrieve one source record by id with its linked fact ids.",
    description: "Retrieve one evidence record by id, including its label, kind, capture date, and the ids of the facts it supports.",
    inputSchema: {
      type: "object",
      properties: { evidenceId: { type: "string", description: "Evidence id such as evidence-photo." } },
      required: ["evidenceId"]
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
    name: "capture_fact",
    title: "Capture dated fact",
    summary: "Add one dated fact the renter gave you.",
    description: "Add one dated, renter-provided fact to the active case. Only record what the renter actually said. Never invent a fact or a date.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", enum: ["Issue", "Location", "First contact", "Entry preference", "Update"] },
        text: { type: "string", description: "The renter's own account, under 280 characters." },
        occurredOn: { type: "string", description: "Date in YYYY-MM-DD format." }
      },
      required: ["label", "text", "occurredOn"]
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: "set_urgency",
    title: "Set case urgency",
    summary: "Set routine, soon, or urgent.",
    description: "Set how soon the renter needs a response: routine, soon, or urgent. This records the renter's own judgement and does not diagnose the property.",
    inputSchema: {
      type: "object",
      properties: { level: { type: "string", enum: ["routine", "soon", "urgent"] } },
      required: ["level"]
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: "compose_request",
    title: "Compose request",
    summary: "Draft the request. Unlocks only when every proof check passes.",
    description: "Build a reviewable request draft in which every factual line cites a fact id from the case. This tool is only registered once all four proof checks pass, so a draft can never be assembled from an incomplete record.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: "request_human_approval",
    title: "Ask the renter to decide",
    summary: "Hand the draft to the renter and wait for a real decision.",
    description: "Put the draft in front of the renter and wait for their decision. This call stays open until they press Approve or Decline in the page. If it returns decision \"no_response\", the renter has not answered yet and the card is still on screen: poll get_case_snapshot to see draftStatus change, and do not ask again. You cannot approve on their behalf and there is no tool that lets you.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "One short line telling the renter what you changed and what you are asking them to confirm." } }
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: "export_packet",
    title: "Export approved packet",
    summary: "Read the packet. Exists only after a human approved.",
    description: "Return the renter-approved evidence packet as JSON. This tool is only registered after the renter has approved, so no agent path can reach an export without a human decision.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  }
];

let seedCase;
let currentCase;
let webMcpLive = false;
let lastNotice = null;
let selectedEvidenceId = null;
let showNewCase = false;
let toolActivity = [];
let pendingResolver = null;
let pendingTimer = null;
const registered = new Map();

function now() { return new Date().toISOString(); }

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function toolText(value) { return typeof value === "string" ? value : JSON.stringify(value); }

/* ---------- persistence ---------- */

function persist() {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentCase)); } catch { /* private mode */ }
}

function restore() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = createCase(JSON.parse(raw));
    // A decision cannot survive a reload: the agent that was waiting is gone.
    parsed.pendingApproval = null;
    return parsed;
  } catch { return null; }
}

/* ---------- routing ---------- */

function currentRoute() {
  const route = window.location.pathname.replace(/\/+$/, "") || "/";
  return ["/", "/case", "/evidence", "/draft", "/activity"].includes(route) ? route : "/";
}

function navigate(route) {
  window.history.pushState({}, "", route);
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function routeLink(route, label, className = "") { return `<a class="${className}" href="${route}" data-route="${route}">${label}</a>`; }
function statusClass(value) { return value === "approved" ? "approved" : value === "soon" ? "soon" : value === "urgent" ? "urgent" : "routine"; }

/* ---------- render ---------- */

function render() {
  if (!currentCase) return;
  const view = snapshot(currentCase);
  const route = currentRoute();
  document.title = route === "/" ? "fixline. | Keep the record" : `fixline. | ${route.slice(1).replace("/", " ")}`;
  badge.textContent = webMcpLive ? `WebMCP live · ${view.availableTools.length} tools` : "Preview mode";
  badge.classList.toggle("preview", !webMcpLive);
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === route);
    link.removeAttribute("aria-current");
    if (link.dataset.nav === route) link.setAttribute("aria-current", "page");
  });
  const body = route === "/" ? homeView(view) : route === "/case" ? caseView(view) : route === "/evidence" ? evidenceView(view) : route === "/draft" ? draftView(view) : activityView(view);
  app.innerHTML = `${approvalBanner(view)}${body}`;
  bindEvents();
  persist();
}

/**
 * The pending decision follows the renter across every route. An agent that is
 * blocked on a person should be impossible to miss.
 */
function approvalBanner(view) {
  if (!view.pendingApproval) return "";
  return `<div class="approval-banner" role="alertdialog" aria-labelledby="approval-banner-title">
    <div class="approval-banner-inner">
      <div class="approval-banner-copy">
        <p class="kicker">The agent is waiting on you</p>
        <h2 id="approval-banner-title">Approve this request?</h2>
        <p>${escapeHtml(view.pendingApproval.note)}</p>
        <p class="small-note">Asked at ${escapeHtml(view.pendingApproval.requestedAt)} · nothing is sent to anyone either way.</p>
      </div>
      <div class="approval-banner-actions">
        <button class="button lime-button" data-action="decide-approve">Approve</button>
        <button class="button outline-light" data-action="decide-decline">Decline</button>
        ${routeLink("/draft", "Read it first →", "text-link light-link")}
      </div>
    </div>
  </div>`;
}

function homeView(view) {
  return `<div class="page-shell home-shell">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy">
        <p class="kicker">Repair records for renters</p>
        <h1 id="page-title">Your repair story,<br /><span>written down.</span></h1>
        <p class="lede">Keep the dates, messages, and photos in one place. An agent can organize the record with you through tools this page hands it. The tools it gets depend on how far the case has come, and only you can approve.</p>
        <div class="hero-actions">${routeLink("/case", "Enter the case desk <span class=\"arrow\">→</span>", "button primary")}${routeLink("/activity", "See the live tool surface", "button ghost")}</div>
        <p class="micro-note"><span class="signal-dot"></span> ${webMcpLive ? `WebMCP is live. ${view.availableTools.length} of ${TOOL_DEFS.length} tools are registered right now.` : "A local sample case is ready."}</p>
      </div>
      <div class="home-preview" aria-label="Fixline workflow preview">
        <div class="preview-head"><span><span class="signal-dot"></span> Fixline</span><span class="mono">CASE / 001</span></div>
        <div class="preview-title">${escapeHtml(view.title)}</div>
        <div class="preview-meta">${escapeHtml(view.location)} <span>•</span> ${view.facts.length} facts <span>•</span> ${view.evidence.length} records</div>
        <div class="preview-track"><div class="preview-step done"><span>01</span><strong>Sources attached</strong><small>${view.evidence.length} records linked to facts</small></div><div class="preview-step ${view.readiness.ready ? "done" : ""}"><span>02</span><strong>Facts in order</strong><small>${escapeHtml(view.readiness.label)}</small></div><div class="preview-step ${view.draft?.status === "approved" ? "done" : ""}"><span>03</span><strong>Ready for review</strong><small>${view.draft?.status === "approved" ? "You approved this packet" : "Waiting for your approval"}</small></div></div>
        <div class="preview-footer"><span class="status ${view.readiness.ready ? "approved" : "soon"}">${view.readiness.ready ? "Proof complete" : "One detail still needed"}</span><span class="mono">LOCAL SAMPLE</span></div>
      </div>
    </section>
    <section class="home-intro" aria-labelledby="how-heading"><div><p class="kicker">Start with the facts</p><h2 id="how-heading">A repair request you can stand behind.</h2></div><p class="section-copy">Fixline keeps each claim attached to a dated fact or source record. The agent cannot draft the request until every proof check passes, and it cannot export anything until you say so.</p></section>
    <section class="steps-grid" aria-label="How Fixline works"><article class="step-card"><span class="step-number">01</span><h3>Write down the facts</h3><p>Record what happened, where it happened, and when you noticed it.</p>${routeLink("/case", "Open the case →", "text-link")}</article><article class="step-card"><span class="step-number">02</span><h3>Check the sources</h3><p>Open each record and see which facts it supports.</p>${routeLink("/evidence", "Review sources →", "text-link")}</article><article class="step-card"><span class="step-number">03</span><h3>Make the call</h3><p>The agent asks. You approve or decline. Nothing leaves without you.</p>${routeLink("/draft", "Open the draft →", "text-link")}</article></section>
    <footer class="home-footer"><span>Fixline © 2026</span><span>Local prototype · WebMCP</span></footer>
  </div>`;
}

function routeHeader(eyebrow, title, copy, action = "") { return `<section class="route-header"><div><p class="kicker">${eyebrow}</p><h1>${title}</h1><p class="lede">${copy}</p></div>${action ? `<div class="route-header-action">${action}</div>` : ""}</section>`; }

function caseView(view) {
  const locked = view.draft?.status === "approved";
  return `<div class="page-shell route-shell">${routeHeader(`CASE / ${escapeHtml(view.id)}`, "Add what happened.", "Record the details while they are fresh. Dates and source links stay beside each fact.", `<button class="button ghost" data-action="toggle-new-case">${showNewCase ? "Cancel" : "Start a new case"}</button>`)}${newCaseForm()}<div class="content-grid"><article class="record-panel" aria-labelledby="case-heading"><div class="panel-top"><div><span class="eyebrow dark-eyebrow">Active case</span><h2 id="case-heading">${escapeHtml(view.title)}</h2><p class="case-meta">${escapeHtml(view.location)} <span>•</span> started ${escapeHtml(view.startedOn)}</p></div><span class="status ${statusClass(view.urgency)}">${escapeHtml(view.urgency)}</span></div><div class="panel-section"><div class="section-label"><span>Repair facts</span><span class="mono">${view.facts.length} FACTS</span></div><ol class="timeline" aria-label="Repair facts">${view.facts.length ? view.facts.map((fact) => `<li class="timeline-item"><span class="timeline-marker" aria-hidden="true"></span><div><p class="fact-label">${escapeHtml(fact.label)}</p><p class="fact-text">${escapeHtml(fact.text)}</p><time class="fact-date" datetime="${escapeHtml(fact.occurredOn)}">${escapeHtml(fact.occurredOn)} · ${escapeHtml(fact.source)}</time>${factEvidence(view.evidence, fact.id)}</div></li>`).join("") : `<li class="empty-state">No repair facts yet. Add the first one below.</li>`}</ol></div>${locked ? `<div class="panel-section"><div class="empty-state">This record is locked. You approved the packet, so the facts behind it can no longer change.</div></div>` : `<form class="capture-form panel-section" data-form="capture"><div class="section-label"><span>Add a fact</span><span class="mono">YOUR ENTRY</span></div><div class="form-row"><div class="field"><label for="fact-label">Fact type</label><select id="fact-label" name="label"><option>Entry preference</option><option>Update</option><option>Issue</option><option>Location</option><option>First contact</option></select></div><div class="field"><label for="fact-date">Date</label><input id="fact-date" name="occurredOn" type="date" value="2026-08-24" required /></div></div><div class="field"><label for="fact-text">What changed?</label><textarea id="fact-text" name="text" placeholder="Example: Please coordinate entry after 5 p.m. on weekdays." required></textarea></div><button class="button dark-button" type="submit">Add to record <span>→</span></button></form>`}</article>${caseRail(view)}</div></div>`;
}

/**
 * An empty case is the smallest surface Fixline ever registers. Letting a
 * visitor start one is the fastest way to show the gate doing real work on
 * facts they chose themselves.
 */
function newCaseForm() {
  if (!showNewCase) return "";
  return `<section class="record-panel new-case-panel" aria-labelledby="new-case-heading">
    <div class="section-label"><span id="new-case-heading">Start a new case</span><span class="mono">EMPTY RECORD</span></div>
    <p class="new-case-note">A new case has nothing proved yet, so only three tools get registered: read the case, add a fact, set urgency. Fill the record in and watch the surface grow on the Activity page.</p>
    <form data-form="new-case">
      <div class="form-row">
        <div class="field"><label for="new-title">What is broken?</label><input id="new-title" name="title" placeholder="Bathroom radiator is cold" required /></div>
        <div class="field"><label for="new-date">Started on</label><input id="new-date" name="startedOn" type="date" value="2026-09-01" required /></div>
      </div>
      <div class="field"><label for="new-location">Where do you live?</label><input id="new-location" name="location" placeholder="Elm House / Flat 2" required /></div>
      <div class="form-actions">
        <button class="button dark-button" type="submit">Create the case <span>&rarr;</span></button>
        <button class="button outline-dark" type="button" data-action="load-sample">Load the sample case</button>
      </div>
    </form>
  </section>`;
}

function caseRail(view) { return `<aside class="support-rail dark-surface"><div class="rail-top"><span class="eyebrow">Case status</span><span class="mono">LOCAL</span></div><div class="rail-number">${view.readiness.complete}<span>/${view.readiness.total}</span></div><p class="rail-title">${escapeHtml(view.readiness.label)}</p><ul class="mini-checks">${view.readiness.checks.map((check) => `<li class="${check.complete ? "complete" : ""}"><span>${check.complete ? "✓" : "·"}</span>${escapeHtml(check.label)}</li>`).join("")}</ul><div class="rail-divider"></div><p class="rail-label">What this unlocks</p><p class="rail-copy">${view.readiness.ready ? "Every check passed, so the drafting tool is now registered for the agent." : "Until every check passes, the drafting tool is not registered and no agent can call it."}</p>${routeLink("/activity", "See the tool surface →", "rail-link")}</aside>`; }

function evidenceView(view) {
  const evidence = view.evidence;
  const selected = evidence.find((item) => item.id === selectedEvidenceId) || evidence[0];
  return `<div class="page-shell route-shell">${routeHeader("EVIDENCE / 02", "Check the source records.", "Open a record to see when it was captured and which facts it supports. The request only uses links that exist in the case.", routeLink("/draft", "Open the draft →", "button ghost"))}<div class="evidence-layout"><section class="evidence-list-panel" aria-labelledby="evidence-list-heading"><div class="section-label"><span id="evidence-list-heading">Source records</span><span class="mono">${evidence.length} RECORDS</span></div><div class="evidence-list">${evidence.map((item) => `<button class="evidence-list-item ${selected?.id === item.id ? "selected" : ""}" data-action="select-evidence" data-evidence-id="${escapeHtml(item.id)}"><span class="evidence-kind">${escapeHtml(item.kind)}</span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.capturedOn)}</small><span class="list-arrow">→</span></button>`).join("")}</div><div class="list-footnote">These records come from the local sample case.</div></section><section class="evidence-detail dark-surface" aria-labelledby="evidence-detail-heading">${selected ? `<div class="rail-top"><span class="eyebrow">Selected record</span><span class="mono">${escapeHtml(selected.id)}</span></div><div class="detail-icon">${escapeHtml(selected.kind.slice(0, 1).toUpperCase())}</div><h2 id="evidence-detail-heading">${escapeHtml(selected.label)}</h2><p class="detail-meta">Captured ${escapeHtml(selected.capturedOn)} <span>•</span> ${escapeHtml(selected.kind)} source</p><div class="detail-block"><p class="rail-label">Facts supported</p><div class="linked-facts">${selected.factIds.map((factId) => { const fact = view.facts.find((entry) => entry.id === factId); return `<span>${escapeHtml(fact?.label || factId)} <small>${escapeHtml(factId)}</small></span>`; }).join("")}</div></div><div class="lookup-block"><p class="rail-label">Look up by ID</p><form data-form="lookup"><div class="lookup-row"><input name="evidenceId" aria-label="Evidence ID" value="${escapeHtml(selected.id)}" /><button class="button lime-button" type="submit">Look up</button></div></form><div class="receipt-region" aria-live="polite">${lastNotice ? noticeHtml(lastNotice) : ""}</div></div>` : `<p class="empty-state">No evidence records yet.</p>`}</section></div></div>`;
}

function draftView(view) {
  return `<div class="page-shell route-shell">${routeHeader("DRAFT / 03", "Review before it leaves.", "Fixline assembles the facts and their source IDs into a request. The agent can ask you to approve it. It has no tool that approves it.")}<div class="draft-layout"><article class="draft-record" aria-labelledby="draft-heading"><div class="panel-top"><div><span class="eyebrow dark-eyebrow">Request packet</span><h2 id="draft-heading">${view.draft ? escapeHtml(view.draft.subject) : "No request yet"}</h2></div><span class="status ${view.draft ? (view.draft.status === "approved" ? "approved" : "needs") : "routine"}">${view.draft ? escapeHtml(view.draft.status === "approved" ? "approved locally" : view.pendingApproval ? "waiting on you" : "needs approval") : "not drafted"}</span></div>${view.draft ? `<div class="draft-copy"><p>${escapeHtml(view.draft.body)}</p><div class="draft-evidence">${view.draft.evidenceIds.map((id) => `<span class="evidence-chip">${escapeHtml(id)}</span>`).join("")}</div></div><div class="approval-row"><p class="approval-note">${view.draft.status === "approved" ? "You approved this packet. The export tool is now available." : "Your decision is the only thing that can approve this."}</p><div class="form-actions">${view.draft.status === "approved" ? `<button class="button outline-dark" data-action="export">Export packet</button>` : `<button class="button dark-button" data-action="approve">Approve request</button>`}</div></div>` : `<div class="draft-empty"><p>${view.readiness.ready ? "Every proof check passed. The request can be composed." : `The drafting tool stays locked until every proof check passes. ${escapeHtml(view.readiness.label)}.`}</p>${view.readiness.ready ? `<button class="button dark-button" data-action="compose">Compose request <span>→</span></button>` : routeLink("/case", "Add the missing fact →", "button dark-button")}</div>`}<div class="receipt-region" aria-live="assertive">${lastNotice ? noticeHtml(lastNotice) : ""}</div></article><aside class="support-rail light-rail"><span class="eyebrow dark-eyebrow">Before you approve</span><h2>${view.readiness.complete}/${view.readiness.total}</h2><p>${escapeHtml(view.readiness.label)}</p><ul class="mini-checks dark-checks">${view.readiness.checks.map((check) => `<li class="${check.complete ? "complete" : ""}"><span>${check.complete ? "✓" : "·"}</span>${escapeHtml(check.label)}</li>`).join("")}</ul>${routeLink("/case", "Back to the case →", "rail-link dark-link")}</aside></div></div>`;
}

/**
 * The tool surface page is the argument. A judge should be able to watch tools
 * appear and disappear as the case moves, without reading a line of source.
 */
function activityView(view) {
  const availability = toolAvailability(currentCase);
  const liveCount = view.availableTools.length;
  return `<div class="page-shell route-shell">${routeHeader("ACTIVITY / 04", "Watch the tool surface move.", "Fixline does not hand an agent a fixed menu. It registers exactly the tools this case state allows and withdraws the rest, so a capability the record is not ready for cannot be called at all.", `<button class="button primary" data-action="demo">Run the agent path <span>→</span></button>`)}<div class="activity-layout"><section class="tool-panel dark-surface" aria-labelledby="tools-heading"><div class="rail-top"><span class="eyebrow" id="tools-heading">Live tool surface</span><span class="status ${webMcpLive ? "approved" : "soon"}">${webMcpLive ? `${liveCount}/${TOOL_DEFS.length} registered` : `${liveCount}/${TOOL_DEFS.length} preview`}</span></div><p class="tool-intro">${webMcpLive ? "These are registered with document.modelContext right now. Locked rows are not registered, so an agent cannot see or call them." : "WebMCP is not exposed in this browser. Preview mode gates the same handlers by the same rules."}</p><div class="tool-list">${TOOL_DEFS.map((tool, index) => { const state = availability[tool.name]; return `<div class="tool-row ${state.available ? "tool-live" : "tool-locked"}"><span class="tool-index">${state.available ? "●" : "○"}</span><div><strong>${tool.name}</strong><p>${escapeHtml(tool.summary)}</p><p class="tool-reason">${state.available ? "Registered" : "Not registered"} · ${escapeHtml(state.reason)}</p></div></div>`; }).join("")}</div><div class="activity-actions"><button class="button outline-light" data-action="reset">Reset sample case</button></div><p class="small-note">Every state change re-registers the surface. Open DevTools and call <span class="mono">document.modelContext.getTools()</span> before and after to see it change.</p></section><section class="receipt-panel" aria-labelledby="receipts-heading"><div class="section-label"><span id="receipts-heading">Action receipts</span><span class="mono">${view.receipts.length} TOTAL</span></div><div class="receipt-list">${view.receipts.length ? view.receipts.slice().reverse().map((receipt) => `<div class="receipt-row ${receipt.result}"><span class="receipt-dot"></span><div><strong>${escapeHtml(receipt.action)}</strong><p>${escapeHtml(receipt.detail)}</p><time>${escapeHtml(receipt.at)}</time></div></div>`).join("") : `<div class="empty-state">No actions yet. Run the agent path to watch the surface change.</div>`}</div><div class="activity-foot"><span>Local state</span><span>Outbound message: unsupported</span></div></section></div></div>`;
}

function factEvidence(evidence, factId) { const items = evidence.filter((item) => item.factIds.includes(factId)); return items.length ? `<div class="evidence-row">${items.map((item) => `<span class="evidence-chip">${escapeHtml(item.kind)} · ${escapeHtml(item.label)}</span>`).join("")}</div>` : ""; }
function noticeHtml(notice) { return `<div class="receipt ${notice.result === "refused" || notice.result === "error" ? "refused" : ""}"><strong>${escapeHtml(notice.action)}</strong><br />${escapeHtml(notice.detail)}</div>`; }
function setNotice(receipt) { lastNotice = receipt; }

/* ---------- tool execution ---------- */

function runTool(name, input = {}) {
  try {
    const receiptCount = currentCase.receipts.length;
    const result = dispatchTool(currentCase, name, input, now());
    currentCase = result.caseData;
    const receipt = currentCase.receipts.length > receiptCount ? currentCase.receipts[currentCase.receipts.length - 1] : null;
    setNotice(receipt);
    render();
    void syncToolSurface();
    return { ok: true, output: result.output, receipt };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The action could not be completed.";
    const receipt = { action: name, result: error?.gated ? "refused" : "error", at: now(), detail };
    setNotice(receipt);
    render();
    return { ok: false, output: detail, receipt, gated: Boolean(error?.gated) };
  }
}

function textResult(payload) {
  return { content: [{ type: "text", text: toolText(payload) }] };
}

/**
 * `request_human_approval` is the only tool that does not return immediately.
 * It parks the agent on a promise that only a renter click can settle.
 */
function awaitHumanDecision(signal) {
  return new Promise((resolve) => {
    pendingResolver = resolve;
    pendingTimer = setTimeout(() => {
      settleDecision({
        decision: "no_response",
        message: "The renter has not answered yet. The decision card is still on screen and the draft is unchanged. Poll get_case_snapshot to see whether draftStatus becomes approved. Do not ask again."
      });
    }, APPROVAL_TIMEOUT_MS);
    signal?.addEventListener("abort", () => {
      settleDecision({ decision: "cancelled", message: "The agent cancelled the request before the renter decided." });
      try { currentCase = resolveApproval(currentCase, "declined", now()); render(); } catch { /* already settled */ }
    }, { once: true });
  });
}

function settleDecision(payload) {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (!pendingResolver) return;
  const resolve = pendingResolver;
  pendingResolver = null;
  resolve(textResult({ tool: "request_human_approval", ...payload }));
}

async function executeTool(name, input, options) {
  if (name === "request_human_approval") {
    const started = runTool(name, input);
    if (!started.ok) return textResult({ tool: name, ok: false, error: started.output });
    return awaitHumanDecision(options?.signal);
  }
  const result = runTool(name, input);
  const output = name === "get_case_snapshot" && result.ok ? compactSnapshot(snapshot(currentCase)) : result.output;
  return textResult({
    tool: name,
    ok: result.ok,
    output,
    availableTools: availableToolNames(currentCase),
    receipt: result.receipt
  });
}

function compactSnapshot(view) {
  return {
    caseId: view.id,
    title: view.title,
    location: view.location,
    urgency: view.urgency,
    proof: {
      readiness: `${view.readiness.complete}/${view.readiness.total}`,
      missing: view.readiness.checks.filter((check) => !check.complete).map((check) => check.label)
    },
    evidenceIds: view.evidence.map((item) => item.id),
    draftStatus: view.draft?.status || "not_drafted",
    awaitingRenterDecision: Boolean(view.pendingApproval),
    availableTools: view.availableTools,
    recentActions: view.receipts.slice(-4).map((receipt) => `${receipt.action}:${receipt.result}`)
  };
}

/* ---------- WebMCP surface ---------- */

/**
 * Reconciles the registered surface against what the case state allows.
 * Registering with an AbortSignal is what makes withdrawal possible, so a tool
 * that stops being legal stops existing for the agent.
 */
async function syncToolSurface() {
  if (!webMcpLive) return;
  const availability = toolAvailability(currentCase);
  for (const def of TOOL_DEFS) {
    const shouldBeLive = availability[def.name].available;
    const isLive = registered.has(def.name);
    if (shouldBeLive && !isLive) {
      const controller = new AbortController();
      try {
        await document.modelContext.registerTool({
          name: def.name,
          title: def.title,
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: def.annotations,
          execute: (input, options) => executeTool(def.name, input || {}, options)
        }, { signal: controller.signal });
        registered.set(def.name, controller);
      } catch { /* leave it unregistered and try again on the next state change */ }
    } else if (!shouldBeLive && isLive) {
      const controller = registered.get(def.name);
      registered.delete(def.name);
      controller.abort();
      if (typeof document.modelContext.unregisterTool === "function") {
        try { await document.modelContext.unregisterTool(def.name); } catch { /* signal already handled it */ }
      }
    }
  }
  const live = Array.from(registered.keys());
  if (live.join() !== toolActivity.join()) {
    toolActivity = live;
    badge.textContent = `WebMCP live · ${live.length} tools`;
  }
}

async function initWebMcp() {
  if (!document.modelContext || typeof document.modelContext.registerTool !== "function") return;
  webMcpLive = true;
  await syncToolSurface();
  render();
}

/* ---------- human actions ---------- */

function startNewCase(input) {
  try {
    currentCase = newCase(input, now());
    showNewCase = false;
    selectedEvidenceId = null;
    settleDecision({ decision: "cancelled", message: "The renter started a different case." });
    setNotice(currentCase.receipts[currentCase.receipts.length - 1]);
    render();
    void syncToolSurface();
  } catch (error) {
    setNotice({ action: "new_case", result: "error", at: now(), detail: error instanceof Error ? error.message : "The case could not be created." });
    render();
  }
}

function resetCase() {
  currentCase = createCase(seedCase);
  lastNotice = null;
  showNewCase = false;
  selectedEvidenceId = null;
  settleDecision({ decision: "cancelled", message: "The renter reset the case." });
  render();
  void syncToolSurface();
}

function decide(decision) {
  try {
    currentCase = resolveApproval(currentCase, decision, now());
    setNotice(currentCase.receipts[currentCase.receipts.length - 1]);
    render();
    void syncToolSurface();
    settleDecision({
      decision,
      message: decision === "approved"
        ? "The renter approved the draft. The export tool is now registered. No message was sent to anyone."
        : "The renter declined. The draft is unchanged and nothing was exported."
    });
  } catch (error) {
    setNotice({ action: "human_decision", result: "error", at: now(), detail: error instanceof Error ? error.message : "The decision could not be recorded." });
    render();
  }
}

function approveHuman() {
  try {
    currentCase = approveByHuman(currentCase, now());
    setNotice(currentCase.receipts[currentCase.receipts.length - 1]);
    render();
    void syncToolSurface();
    settleDecision({ decision: "approved", message: "The renter approved the draft directly in the page." });
  } catch (error) {
    setNotice({ action: "human_approval", result: "error", at: now(), detail: error instanceof Error ? error.message : "Approval failed." });
    render();
  }
}

function exportPacket() {
  try {
    const blob = new Blob([packetFor(currentCase)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentCase.id.toLowerCase()}-fixline-packet.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice({ action: "export_packet", result: "ok", at: now(), detail: "Local packet downloaded." });
    render();
  } catch (error) {
    setNotice({ action: "export_packet", result: "error", at: now(), detail: error instanceof Error ? error.message : "The packet could not be downloaded." });
    render();
  }
}

/**
 * Replays the agent path in preview mode, including the two moments that matter:
 * the drafting tool being unavailable before the record is complete, and the
 * approval request parking on the renter.
 */
function runDemo() {
  resetCase();
  runTool("get_case_snapshot");
  runTool("compose_request");
  runTool("capture_fact", { label: "Entry preference", text: "Please coordinate entry after 5 p.m. on weekdays.", occurredOn: "2026-08-24" });
  runTool("set_urgency", { level: "soon" });
  runTool("compose_request");
  runTool("request_human_approval", { note: "I added your entry preference and set urgency to soon. Approve to unlock the export." });
}

function bindEvents() {
  document.querySelectorAll("[data-route]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); navigate(link.dataset.route); }));
  document.querySelector("[data-action=demo]")?.addEventListener("click", runDemo);
  document.querySelector("[data-action=reset]")?.addEventListener("click", resetCase);
  document.querySelector("[data-action=toggle-new-case]")?.addEventListener("click", () => { showNewCase = !showNewCase; render(); });
  document.querySelector("[data-action=load-sample]")?.addEventListener("click", () => { showNewCase = false; resetCase(); });
  document.querySelector("[data-form=new-case]")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startNewCase({ title: form.get("title"), location: form.get("location"), startedOn: form.get("startedOn") }); });
  document.querySelector("[data-action=compose]")?.addEventListener("click", () => runTool("compose_request"));
  document.querySelector("[data-action=approve]")?.addEventListener("click", approveHuman);
  document.querySelector("[data-action=decide-approve]")?.addEventListener("click", () => decide("approved"));
  document.querySelector("[data-action=decide-decline]")?.addEventListener("click", () => decide("declined"));
  document.querySelector("[data-action=export]")?.addEventListener("click", exportPacket);
  document.querySelectorAll("[data-action=select-evidence]").forEach((button) => button.addEventListener("click", () => { selectedEvidenceId = button.dataset.evidenceId; render(); }));
  document.querySelector("[data-form=capture]")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); runTool("capture_fact", { label: form.get("label"), text: form.get("text"), occurredOn: form.get("occurredOn") }); });
  document.querySelector("[data-form=lookup]")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); runTool("get_evidence_item", { evidenceId: form.get("evidenceId") }); });
}

window.addEventListener("popstate", render);

async function init() {
  try {
    const response = await fetch("fixtures/repair-case.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Sample case could not be loaded.");
    seedCase = await response.json();
    currentCase = restore() || createCase(seedCase);
    render();
    await initWebMcp();
  } catch {
    app.innerHTML = `<div class="page-shell"><section class="dark-surface error-panel"><p class="kicker">Unavailable</p><h1>Sample case unavailable.</h1><p class="lede">The local fixture could not load. Start the static server from the repository root and try again.</p></section></div>`;
    badge.textContent = "Unavailable";
    badge.classList.add("preview");
  }
}

window.fixline = {
  runTool,
  resetCase,
  getSnapshot: () => snapshot(currentCase),
  availableTools: () => availableToolNames(currentCase)
};

init();
