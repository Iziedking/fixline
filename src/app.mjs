import { approveByHuman, dispatchTool, packetFor, snapshot, createCase } from "./core.mjs";

const app = document.querySelector("#app");
const badge = document.querySelector("#capability-badge");
const toolNames = [
  ["get_case_snapshot", "Read the current case and proof gaps."],
  ["get_evidence_item", "Retrieve one evidence record by id."],
  ["capture_fact", "Add a dated fact to the renter's timeline."],
  ["set_urgency", "Change urgency without changing the evidence."],
  ["compose_request", "Draft a request with evidence references."],
  ["approve_request", "Attempt approval and meet the human boundary."]
];

let seedCase;
let currentCase;
let webMcpLive = false;
let lastNotice = null;
let selectedEvidenceId = null;

function now() { return new Date().toISOString(); }

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function toolText(value) { return typeof value === "string" ? value : JSON.stringify(value); }

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

function render() {
  if (!currentCase) return;
  const view = snapshot(currentCase);
  const route = currentRoute();
  document.title = route === "/" ? "fixline. | Keep the record" : `fixline. | ${route.slice(1).replace("/", " ")}`;
  badge.textContent = webMcpLive ? "WebMCP connected" : "Preview mode";
  badge.classList.toggle("preview", !webMcpLive);
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === route);
    link.removeAttribute("aria-current");
    if (link.dataset.nav === route) link.setAttribute("aria-current", "page");
  });
  app.innerHTML = route === "/" ? homeView(view) : route === "/case" ? caseView(view) : route === "/evidence" ? evidenceView(view) : route === "/draft" ? draftView(view) : activityView(view);
  bindEvents();
}

function homeView(view) {
  return `<div class="page-shell home-shell">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy">
        <p class="kicker">Repair records for renters</p>
        <h1 id="page-title">Your repair story,<br /><span>written down.</span></h1>
        <p class="lede">Keep the dates, messages, and photos in one place. Fixline organizes the record and prepares a request. You decide what goes out.</p>
        <div class="hero-actions">${routeLink("/case", "Enter the case desk <span class=\"arrow\">→</span>", "button primary")}${routeLink("/evidence", "See the evidence", "button ghost")}</div>
        <p class="micro-note"><span class="signal-dot"></span> A local sample case is ready.</p>
      </div>
      <div class="home-preview" aria-label="Fixline workflow preview">
        <div class="preview-head"><span><span class="signal-dot"></span> Fixline</span><span class="mono">CASE / 001</span></div>
        <div class="preview-title">${escapeHtml(view.title)}</div>
        <div class="preview-meta">${escapeHtml(view.location)} <span>•</span> ${view.facts.length} facts <span>•</span> ${view.evidence.length} records</div>
        <div class="preview-track"><div class="preview-step done"><span>01</span><strong>Sources attached</strong><small>${view.evidence.length} records linked to facts</small></div><div class="preview-step done"><span>02</span><strong>Facts in order</strong><small>Dates and context stay together</small></div><div class="preview-step"><span>03</span><strong>Ready for review</strong><small>Waiting for your approval</small></div></div>
        <div class="preview-footer"><span class="status soon">One detail still needed</span><span class="mono">LOCAL SAMPLE</span></div>
      </div>
    </section>
    <section class="home-intro" aria-labelledby="how-heading"><div><p class="kicker">Start with the facts</p><h2 id="how-heading">A repair request you can stand behind.</h2></div><p class="section-copy">Fixline keeps each claim attached to a dated fact or source record. When the packet is ready, you review it before export.</p></section>
    <section class="steps-grid" aria-label="How Fixline works"><article class="step-card"><span class="step-number">01</span><h3>Write down the facts</h3><p>Record what happened, where it happened, and when you noticed it.</p>${routeLink("/case", "Open the case →", "text-link")}</article><article class="step-card"><span class="step-number">02</span><h3>Check the sources</h3><p>Open each record and see which facts it supports.</p>${routeLink("/evidence", "Review sources →", "text-link")}</article><article class="step-card"><span class="step-number">03</span><h3>Review the request</h3><p>Read the packet before you approve a local export.</p>${routeLink("/draft", "Open the draft →", "text-link")}</article></section>
    <footer class="home-footer"><span>Fixline © 2026</span><span>Local prototype · WebMCP-ready</span></footer>
  </div>`;
}

function routeHeader(eyebrow, title, copy, action = "") { return `<section class="route-header"><div><p class="kicker">${eyebrow}</p><h1>${title}</h1><p class="lede">${copy}</p></div>${action ? `<div class="route-header-action">${action}</div>` : ""}</section>`; }

function caseView(view) {
  return `<div class="page-shell route-shell">${routeHeader("CASE / 001", "Add what happened.", "Record the details while they are fresh. Dates and source links stay beside each fact.", routeLink("/evidence", "View evidence →", "button ghost"))}<div class="content-grid"><article class="record-panel" aria-labelledby="case-heading"><div class="panel-top"><div><span class="eyebrow dark-eyebrow">Active case</span><h2 id="case-heading">${escapeHtml(view.title)}</h2><p class="case-meta">${escapeHtml(view.location)} <span>•</span> started ${escapeHtml(view.startedOn)}</p></div><span class="status ${statusClass(view.urgency)}">${escapeHtml(view.urgency)}</span></div><div class="panel-section"><div class="section-label"><span>Repair facts</span><span class="mono">${view.facts.length} FACTS</span></div><ol class="timeline" aria-label="Repair facts">${view.facts.length ? view.facts.map((fact) => `<li class="timeline-item"><span class="timeline-marker" aria-hidden="true"></span><div><p class="fact-label">${escapeHtml(fact.label)}</p><p class="fact-text">${escapeHtml(fact.text)}</p><time class="fact-date" datetime="${escapeHtml(fact.occurredOn)}">${escapeHtml(fact.occurredOn)} · ${escapeHtml(fact.source)}</time>${factEvidence(view.evidence, fact.id)}</div></li>`).join("") : `<li class="empty-state">No repair facts yet. Add the first one below.</li>`}</ol></div><form class="capture-form panel-section" data-form="capture"><div class="section-label"><span>Add a fact</span><span class="mono">YOUR ENTRY</span></div><div class="form-row"><div class="field"><label for="fact-label">Fact type</label><select id="fact-label" name="label"><option>Entry preference</option><option>Update</option><option>Issue</option><option>Location</option><option>First contact</option></select></div><div class="field"><label for="fact-date">Date</label><input id="fact-date" name="occurredOn" type="date" value="2026-08-24" required /></div></div><div class="field"><label for="fact-text">What changed?</label><textarea id="fact-text" name="text" placeholder="Example: Please coordinate entry after 5 p.m. on weekdays." required></textarea></div><button class="button dark-button" type="submit">Add to record <span>→</span></button></form></article>${caseRail(view)}</div></div>`;
}

function caseRail(view) { return `<aside class="support-rail dark-surface"><div class="rail-top"><span class="eyebrow">Case status</span><span class="mono">LOCAL</span></div><div class="rail-number">${view.readiness.complete}<span>/${view.readiness.total}</span></div><p class="rail-title">${escapeHtml(view.readiness.label)}</p><ul class="mini-checks">${view.readiness.checks.map((check) => `<li class="${check.complete ? "complete" : ""}"><span>${check.complete ? "✓" : "·"}</span>${escapeHtml(check.label)}</li>`).join("")}</ul><div class="rail-divider"></div><p class="rail-label">Next step</p><p class="rail-copy">${view.draft ? "The request is ready to read." : "Open the source records before writing the request."}</p>${routeLink(view.draft ? "/draft" : "/evidence", view.draft ? "Read the request →" : "Open the sources →", "rail-link")}</aside>`; }

function evidenceView(view) {
  const evidence = view.evidence;
  const selected = evidence.find((item) => item.id === selectedEvidenceId) || evidence[0];
  return `<div class="page-shell route-shell">${routeHeader("EVIDENCE / 02", "Check the source records.", "Open a record to see when it was captured and which facts it supports. The request only uses links that exist in the case.", routeLink("/draft", "Open the draft →", "button ghost"))}<div class="evidence-layout"><section class="evidence-list-panel" aria-labelledby="evidence-list-heading"><div class="section-label"><span id="evidence-list-heading">Source records</span><span class="mono">${evidence.length} RECORDS</span></div><div class="evidence-list">${evidence.map((item) => `<button class="evidence-list-item ${selected?.id === item.id ? "selected" : ""}" data-action="select-evidence" data-evidence-id="${escapeHtml(item.id)}"><span class="evidence-kind">${escapeHtml(item.kind)}</span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.capturedOn)}</small><span class="list-arrow">→</span></button>`).join("")}</div><div class="list-footnote">These records come from the local sample case.</div></section><section class="evidence-detail dark-surface" aria-labelledby="evidence-detail-heading">${selected ? `<div class="rail-top"><span class="eyebrow">Selected record</span><span class="mono">${escapeHtml(selected.id)}</span></div><div class="detail-icon">${escapeHtml(selected.kind.slice(0, 1).toUpperCase())}</div><h2 id="evidence-detail-heading">${escapeHtml(selected.label)}</h2><p class="detail-meta">Captured ${escapeHtml(selected.capturedOn)} <span>•</span> ${escapeHtml(selected.kind)} source</p><div class="detail-block"><p class="rail-label">Facts supported</p><div class="linked-facts">${selected.factIds.map((factId) => { const fact = view.facts.find((entry) => entry.id === factId); return `<span>${escapeHtml(fact?.label || factId)} <small>${escapeHtml(factId)}</small></span>`; }).join("")}</div></div><div class="lookup-block"><p class="rail-label">Look up by ID</p><form data-form="lookup"><div class="lookup-row"><input name="evidenceId" aria-label="Evidence ID" value="${escapeHtml(selected.id)}" /><button class="button lime-button" type="submit">Look up</button></div></form><div class="receipt-region" aria-live="polite">${lastNotice ? noticeHtml(lastNotice) : ""}</div></div>` : `<p class="empty-state">No evidence records yet.</p>`}</section></div></div>`;
}

function draftView(view) {
  return `<div class="page-shell route-shell">${routeHeader("DRAFT / 03", "Review before it leaves.", "Fixline has assembled the facts and their source IDs into a request. Read it, approve it, or leave it here. The agent cannot send it.")}<div class="draft-layout"><article class="draft-record" aria-labelledby="draft-heading"><div class="panel-top"><div><span class="eyebrow dark-eyebrow">Request packet</span><h2 id="draft-heading">${view.draft ? escapeHtml(view.draft.subject) : "No request yet"}</h2></div><span class="status ${view.draft ? (view.draft.status === "approved" ? "approved" : "needs") : "routine"}">${view.draft ? escapeHtml(view.draft.status === "approved" ? "approved locally" : "needs approval") : "not drafted"}</span></div>${view.draft ? `<div class="draft-copy"><p>${escapeHtml(view.draft.body)}</p><div class="draft-evidence">${view.draft.evidenceIds.map((id) => `<span class="evidence-chip">${escapeHtml(id)}</span>`).join("")}</div></div><div class="approval-row"><p class="approval-note">Your approval is required before export.</p><div class="form-actions"><button class="button dark-button" data-action="approve" ${view.draft.status === "approved" ? "disabled" : ""}>${view.draft.status === "approved" ? "Approved locally" : "Approve request"}</button>${view.draft.status === "approved" ? `<button class="button outline-dark" data-action="export">Export packet</button>` : ""}</div></div>` : `<div class="draft-empty"><p>Add the missing fact, then compose the request packet.</p><button class="button dark-button" data-action="compose">Compose request <span>→</span></button></div>`}<div class="receipt-region" aria-live="assertive">${lastNotice ? noticeHtml(lastNotice) : ""}</div></article><aside class="support-rail light-rail"><span class="eyebrow dark-eyebrow">Before you approve</span><h2>${view.readiness.complete}/${view.readiness.total}</h2><p>${escapeHtml(view.readiness.label)}</p><ul class="mini-checks dark-checks">${view.readiness.checks.map((check) => `<li class="${check.complete ? "complete" : ""}"><span>${check.complete ? "✓" : "·"}</span>${escapeHtml(check.label)}</li>`).join("")}</ul>${routeLink("/case", "Back to the case →", "rail-link dark-link")}</aside></div></div>`;
}

function activityView(view) {
  return `<div class="page-shell route-shell">${routeHeader("ACTIVITY / 04", "Inspect each action.", "This page lists the tools available to a browser agent and the receipts each action leaves behind. Approval is yours.", `<button class="button primary" data-action="demo">Run proof path <span>→</span></button>`)}<div class="activity-layout"><section class="tool-panel dark-surface" aria-labelledby="tools-heading"><div class="rail-top"><span class="eyebrow" id="tools-heading">Available tools</span><span class="status ${webMcpLive ? "approved" : "soon"}">${webMcpLive ? "live" : "preview"}</span></div><p class="tool-intro">Each tool has a narrow job. The receipt list records what happened.</p><div class="tool-list">${toolNames.map(([name, description], index) => `<div class="tool-row"><span class="tool-index">0${index + 1}</span><div><strong>${name}</strong><p>${description}</p></div></div>`).join("")}</div><div class="activity-actions"><button class="button primary" data-action="compose">Draft request</button><button class="button outline-light" data-action="refuse">Test approval refusal</button></div><p class="small-note">${webMcpLive ? "These tools are available to a browser agent on this page." : "WebMCP is not exposed in this browser. Preview mode runs the same handlers locally."}</p></section><section class="receipt-panel" aria-labelledby="receipts-heading"><div class="section-label"><span id="receipts-heading">Action receipts</span><span class="mono">${view.receipts.length} TOTAL</span></div><div class="receipt-list">${view.receipts.length ? view.receipts.slice().reverse().map((receipt) => `<div class="receipt-row ${receipt.result}"><span class="receipt-dot"></span><div><strong>${escapeHtml(receipt.action)}</strong><p>${escapeHtml(receipt.detail)}</p><time>${escapeHtml(receipt.at)}</time></div></div>`).join("") : `<div class="empty-state">No actions yet. Run the proof path to see the approval refusal.</div>`}</div><div class="activity-foot"><span>Local state</span><span>Outbound message: unsupported</span></div></section></div></div>`;
}

function factEvidence(evidence, factId) { const items = evidence.filter((item) => item.factIds.includes(factId)); return items.length ? `<div class="evidence-row">${items.map((item) => `<span class="evidence-chip">${escapeHtml(item.kind)} · ${escapeHtml(item.label)}</span>`).join("")}</div>` : ""; }
function noticeHtml(notice) { return `<div class="receipt ${notice.result === "refused" ? "refused" : ""}"><strong>${escapeHtml(notice.action)}</strong><br />${escapeHtml(notice.detail)}</div>`; }
function setNotice(receipt) { lastNotice = receipt; }

function runTool(name, input = {}) {
  try {
    const receiptCount = currentCase.receipts.length;
    const result = dispatchTool(currentCase, name, input, now());
    currentCase = result.caseData;
    const receipt = currentCase.receipts.length > receiptCount ? currentCase.receipts[currentCase.receipts.length - 1] : null;
    setNotice(receipt); render(); return { ok: true, output: result.output, receipt };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The action could not be completed.";
    const receipt = { action: name, result: "error", at: now(), detail };
    setNotice(receipt); render(); return { ok: false, output: detail, receipt };
  }
}

function resetCase() { currentCase = createCase(seedCase); lastNotice = null; selectedEvidenceId = null; render(); }
function runDemo() { resetCase(); runTool("get_case_snapshot"); runTool("capture_fact", { label: "Entry preference", text: "Please coordinate entry after 5 p.m. on weekdays.", occurredOn: "2026-08-24" }); runTool("set_urgency", { level: "soon" }); runTool("compose_request"); runTool("approve_request"); }

function approveHuman() {
  try { currentCase = approveByHuman(currentCase, now()); setNotice(currentCase.receipts[currentCase.receipts.length - 1]); render(); }
  catch (error) { setNotice({ action: "human_approval", result: "error", at: now(), detail: error instanceof Error ? error.message : "Approval failed." }); render(); }
}

function exportPacket() {
  try {
    const blob = new Blob([packetFor(currentCase)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${currentCase.id.toLowerCase()}-fixline-packet.json`; link.click(); URL.revokeObjectURL(url); setNotice({ action: "export_packet", result: "ok", at: now(), detail: "Local packet downloaded." }); render();
  } catch { setNotice({ action: "export_packet", result: "error", at: now(), detail: "The packet could not be downloaded. Try again." }); render(); }
}

function bindEvents() {
  document.querySelectorAll("[data-route]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); navigate(link.dataset.route); }));
  document.querySelector("[data-action=demo]")?.addEventListener("click", runDemo);
  document.querySelector("[data-action=compose]")?.addEventListener("click", () => runTool("compose_request"));
  document.querySelector("[data-action=refuse]")?.addEventListener("click", () => runTool("approve_request"));
  document.querySelector("[data-action=approve]")?.addEventListener("click", approveHuman);
  document.querySelector("[data-action=export]")?.addEventListener("click", exportPacket);
  document.querySelectorAll("[data-action=select-evidence]").forEach((button) => button.addEventListener("click", () => { selectedEvidenceId = button.dataset.evidenceId; render(); }));
  document.querySelector("[data-form=capture]")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); runTool("capture_fact", { label: form.get("label"), text: form.get("text"), occurredOn: form.get("occurredOn") }); });
  document.querySelector("[data-form=lookup]")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); runTool("get_evidence_item", { evidenceId: form.get("evidenceId") }); });
}

async function registerWebMcp() {
  if (!document.modelContext || typeof document.modelContext.registerTool !== "function") return;
  webMcpLive = true;
  const tools = [
    { name: "get_case_snapshot", title: "Read repair case", description: "Read the active renter repair case, proof gaps, evidence ids, draft status, and recent receipts.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => toolResult("get_case_snapshot") },
    { name: "get_evidence_item", title: "Read evidence item", description: "Retrieve one evidence record by id, including its label, kind, capture date, and linked fact ids.", inputSchema: { type: "object", properties: { evidenceId: { type: "string", description: "Evidence id such as evidence-photo." } }, required: ["evidenceId"] }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input) => toolResult("get_evidence_item", input) },
    { name: "capture_fact", title: "Capture dated fact", description: "Add one dated, user-provided fact to the active repair case. Never invent facts.", inputSchema: { type: "object", properties: { label: { type: "string", description: "Issue, Location, First contact, Entry preference, or Update." }, text: { type: "string", description: "The renter's exact fact, under 280 characters." }, occurredOn: { type: "string", description: "Date in YYYY-MM-DD format." } }, required: ["label", "text", "occurredOn"] }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: (input) => toolResult("capture_fact", input) },
    { name: "set_urgency", title: "Set case urgency", description: "Set urgency to routine, soon, or urgent. This does not diagnose the issue.", inputSchema: { type: "object", properties: { level: { type: "string", enum: ["routine", "soon", "urgent"] } }, required: ["level"] }, annotations: { readOnlyHint: false }, execute: (input) => toolResult("set_urgency", input) },
    { name: "compose_request", title: "Compose request", description: "Create a reviewable request draft whose factual lines cite evidence ids from the case.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: () => toolResult("compose_request") },
    { name: "approve_request", title: "Request approval", description: "Attempt approval. This always refuses because only the renter's visible button can approve communication.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false }, execute: () => toolResult("approve_request") }
  ];
  try { for (const tool of tools) await document.modelContext.registerTool(tool); } catch { webMcpLive = false; setNotice({ action: "webmcp_registration", result: "error", at: now(), detail: "WebMCP could not register. Preview mode remains available." }); }
  render();
}

function toolResult(name, input = {}) { const result = runTool(name, input); const output = name === "get_case_snapshot" && result.ok ? compactSnapshot(snapshot(currentCase)) : result.output; return { content: [{ type: "text", text: toolText({ tool: name, ok: result.ok, output, receipt: result.receipt }) }] }; }
function compactSnapshot(view) { return { caseId: view.id, title: view.title, location: view.location, urgency: view.urgency, proof: { readiness: `${view.readiness.complete}/${view.readiness.total}`, missing: view.readiness.checks.filter((check) => !check.complete).map((check) => check.label) }, evidenceIds: view.evidence.map((item) => item.id), draftStatus: view.draft?.status || "not_drafted", recentActions: view.receipts.slice(-4).map((receipt) => `${receipt.action}:${receipt.result}`) }; }

window.addEventListener("popstate", render);

async function init() {
  try { const response = await fetch("fixtures/repair-case.json", { cache: "no-store" }); if (!response.ok) throw new Error("Sample case could not be loaded."); seedCase = await response.json(); currentCase = createCase(seedCase); render(); await registerWebMcp(); }
  catch { app.innerHTML = `<div class="page-shell"><section class="dark-surface error-panel"><p class="kicker">Unavailable</p><h1>Sample case unavailable.</h1><p class="lede">The local fixture could not load. Start the static server from the repository root and try again.</p></section></div>`; badge.textContent = "Unavailable"; badge.classList.add("preview"); }
}

window.fixline = { runTool, resetCase, getSnapshot: () => snapshot(currentCase) };
init();
