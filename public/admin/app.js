const state = {
  me: null,
  overview: null,
  workspaces: [],
  errors: [],
  system: null,
  queue: null,
  currentPage: "overview"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options
  });

  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json")
    ? await response.json()
    : null;

  if (!response.ok) {
    const error = new Error(body?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function shortDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function statusBadge(status) {
  const value = String(status || "unknown");
  const good = ["active", "connected", "healthy", "sent", "trialing"].includes(value);
  const bad = ["failed", "disconnected", "canceled", "error"].includes(value);
  const cls = good ? "good" : bad ? "bad" : "warn";
  return `<span class="badge ${cls}">${escapeHtml(value)}</span>`;
}

function metricCard(label, value, hint = "") {
  return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></article>`;
}

function pageText(page) {
  return ({
    overview: ["Overview", "Customer and automation health."],
    workspaces: ["Customers", "Workspaces, plans, usage and connections."],
    errors: ["Errors", "Recent customer-impacting delivery failures."],
    system: ["System", "Worker and Instagram token health."]
  })[page] || ["Overview", "Customer and automation health."];
}

function changePage(page) {
  state.currentPage = page;
  $$(".page").forEach(item => item.classList.toggle("hidden", item.id !== `page-${page}`));
  $$(".nav-item[data-page]").forEach(item => item.classList.toggle("active", item.dataset.page === page));
  const [title, subtitle] = pageText(page);
  $("#pageTitle").textContent = title;
  $("#pageSubtitle").textContent = subtitle;

  if (page === "workspaces") loadWorkspaces($("#workspaceSearch")?.value || "");
  if (page === "errors") loadErrors();
  if (page === "system") loadSystem();
}

function renderOverviewSystem() {
  const services = state.system?.services || [];
  const worker = services.find(item => item.service_name === "instagram-worker");
  const workerHealthy = worker && Number(worker.age_seconds) <= 90;

  $("#overviewSystem").innerHTML = `
    <div class="list">
      <div class="list-row">
        <div><strong>API</strong><small>Current admin request succeeded.</small></div>
        <span class="badge good">Healthy</span>
      </div>
      <div class="list-row">
        <div><strong>Instagram worker</strong><small>${worker ? `Heartbeat ${escapeHtml(worker.age_seconds)}s ago` : "No heartbeat yet"}</small></div>
        <span class="badge ${workerHealthy ? "good" : "bad"}">${workerHealthy ? "Healthy" : "Needs attention"}</span>
      </div>
    </div>`;
}

function renderOverview() {
  const overview = state.overview || {};
  $("#overviewCards").innerHTML = [
    metricCard("Customers", overview.customers || 0, `${overview.workspaces || 0} workspace(s)`),
    metricCard("Connected Instagram", overview.connected_accounts || 0, `${overview.accounts_requiring_reauth || 0} reconnect required`),
    metricCard("Active automations", overview.active_automations || 0, "Across all workspaces"),
    metricCard("DMs this month", overview.dm_sent_this_month || 0, "Successful private replies"),
    metricCard("DM failures", overview.dm_failed_24h || 0, "Last 24 hours"),
    metricCard("Public reply failures", overview.public_reply_failed_24h || 0, "Last 24 hours"),
    metricCard("Token warnings", overview.tokens_expiring_14d || 0, "Expire within 14 days")
  ].join("");

  const attention = [];
  if (Number(overview.accounts_requiring_reauth) > 0) attention.push(["Instagram reconnect required", `${overview.accounts_requiring_reauth} account(s) need customer attention.`, "warn"]);
  if (Number(overview.dm_failed_24h) > 0) attention.push(["DM delivery failures", `${overview.dm_failed_24h} failed in the last 24 hours.`, "bad"]);
  if (Number(overview.public_reply_failed_24h) > 0) attention.push(["Public reply failures", `${overview.public_reply_failed_24h} failed in the last 24 hours.`, "bad"]);
  if (Number(overview.tokens_expiring_14d) > 0) attention.push(["Instagram token expiry", `${overview.tokens_expiring_14d} token(s) expire within 14 days.`, "warn"]);

  $("#attentionList").innerHTML = attention.length
    ? `<div class="list">${attention.map(([title, text, cls]) => `<div class="list-row"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(text)}</small></div><span class="badge ${cls}">Review</span></div>`).join("")}</div>`
    : `<div class="empty">No customer-impacting issues detected.</div>`;

  renderOverviewSystem();
}

async function loadOverview() {
  const [overview, system] = await Promise.all([
    api("/api/admin/overview"),
    api("/api/admin/system")
  ]);
  state.overview = overview.overview || {};
  state.system = system || null;
  renderOverview();
}

function renderWorkspaces() {
  const root = $("#workspaceTable");
  if (!state.workspaces.length) {
    root.innerHTML = `<div class="empty">No matching customers.</div>`;
    return;
  }

  root.innerHTML = `
    <table>
      <thead><tr><th>Workspace</th><th>Owner</th><th>Plan</th><th>Instagram</th><th>Automations</th><th>DM usage</th><th>Status</th></tr></thead>
      <tbody>
        ${state.workspaces.map(item => `
          <tr class="clickable-row" data-workspace-id="${escapeHtml(item.id)}">
            <td><strong>${escapeHtml(item.name)}</strong><div class="muted">${shortDate(item.created_at)}</div></td>
            <td>${escapeHtml(item.owner_display_name || item.owner_email || "—")}<div class="muted">${escapeHtml(item.owner_email || "")}</div></td>
            <td><strong>${escapeHtml(item.plan_code || "—")}</strong></td>
            <td>${escapeHtml(item.connected_accounts)}</td>
            <td>${escapeHtml(item.active_automations)}</td>
            <td>${escapeHtml(item.dm_sent_count)} / ${escapeHtml(item.monthly_dm_limit ?? "—")}</td>
            <td>${statusBadge(item.subscription_status || item.status)}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;

  $$(".clickable-row").forEach(row => {
    row.addEventListener("click", () => openWorkspace(row.dataset.workspaceId));
  });
}

async function loadWorkspaces(search = "") {
  try {
    const result = await api(`/api/admin/workspaces?search=${encodeURIComponent(search)}&limit=100`);
    state.workspaces = result.workspaces || [];
    renderWorkspaces();
  } catch {
    toast("Could not load customers.");
  }
}

function activitySummary(item) {
  if (item.dm_status === "sent") return "DM sent";
  if (item.dm_status === "failed") return item.dm_failure_message || "DM failed";
  if (item.comment_status === "ignored") return item.ignore_reason || "Comment ignored";
  return item.comment_status || item.dm_status || "Received";
}

async function openWorkspace(id) {
  try {
    const detail = await api(`/api/admin/workspaces/${encodeURIComponent(id)}`);
    const w = detail.workspace;
    const owner = detail.members.find(item => item.role === "owner");
    $("#drawerTitle").textContent = w.name;

    $("#drawerBody").innerHTML = `
      <section class="detail-card">
        <h3>Customer</h3>
        <div class="detail-grid">
          <div class="detail-item"><span>Owner</span><strong>${escapeHtml(owner?.display_name || owner?.email || "—")}</strong></div>
          <div class="detail-item"><span>Email</span><strong>${escapeHtml(owner?.email || "—")}</strong></div>
          <div class="detail-item"><span>Plan</span><strong>${escapeHtml(w.plan_code || "—")}</strong></div>
          <div class="detail-item"><span>Subscription</span><strong>${escapeHtml(w.subscription_status || "—")}</strong></div>
          <div class="detail-item"><span>DM usage</span><strong>${escapeHtml(w.dm_sent_count)} / ${escapeHtml(w.monthly_dm_limit ?? "—")}</strong></div>
          <div class="detail-item"><span>Active sessions</span><strong>${escapeHtml(detail.activeSessions)}</strong></div>
        </div>
      </section>
      <section class="detail-card">
        <h3>Instagram accounts</h3>
        ${detail.accounts.length ? `<div class="list">${detail.accounts.map(account => `<div class="list-row"><div><strong>@${escapeHtml(account.username || "instagram")}</strong><small>Token expiry: ${escapeHtml(shortDate(account.token_expires_at))} · webhook ${account.comments_subscribed_at ? "subscribed" : "not recorded"}</small></div>${statusBadge(account.status)}</div>`).join("")}</div>` : `<div class="empty">No Instagram accounts.</div>`}
      </section>
      <section class="detail-card">
        <h3>Automations</h3>
        ${detail.automations.length ? `<div class="list">${detail.automations.map(automation => `<div class="list-row"><div><strong>${escapeHtml(automation.keyword)} · @${escapeHtml(automation.instagram_username || "instagram")}</strong><small>${escapeHtml(automation.match_mode)} · public reply ${automation.public_reply_enabled ? "on" : "off"}</small></div><div class="row-actions"><span class="badge ${automation.active ? "good" : "warn"}">${automation.active ? "Active" : "Paused"}</span>${automation.active ? `<button class="button small" data-pause-automation="${escapeHtml(automation.id)}" data-workspace-id="${escapeHtml(w.id)}">Pause</button>` : ""}</div></div>`).join("")}</div>` : `<div class="empty">No automations.</div>`}
      </section>
      <section class="detail-card">
        <h3>Recent activity</h3>
        ${detail.activity.length ? detail.activity.slice(0, 15).map(item => `<div class="activity-entry"><strong>${item.commenter_username ? `@${escapeHtml(item.commenter_username)}` : "Instagram user"} · @${escapeHtml(item.instagram_username || "instagram")}</strong><p>${escapeHtml(item.comment_text || "—")}</p><small class="${item.dm_status === "failed" ? "error-text" : "muted"}">${escapeHtml(activitySummary(item))} · ${escapeHtml(formatDate(item.received_at))}</small></div>`).join("") : `<div class="empty">No recent activity.</div>`}
      </section>
      <section class="detail-card">
        <h3>Recent audit events</h3>
        ${detail.audit.length ? `<div class="list">${detail.audit.slice(0, 15).map(item => `<div class="list-row"><div><strong>${escapeHtml(item.event_type)}</strong><small>${escapeHtml(formatDate(item.created_at))}</small></div></div>`).join("")}</div>` : `<div class="empty">No audit events.</div>`}
      </section>`;

    $$('[data-pause-automation]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/admin/workspaces/${encodeURIComponent(button.dataset.workspaceId)}/automations/${encodeURIComponent(button.dataset.pauseAutomation)}/pause`, { method: 'POST' });
          toast('Automation paused.');
          await openWorkspace(button.dataset.workspaceId);
        } catch (error) {
          toast(error.body?.error || 'Could not pause automation.');
        } finally {
          button.disabled = false;
        }
      });
    });

    $("#drawerBackdrop").classList.remove("hidden");
    $("#workspaceDrawer").classList.remove("hidden");
  } catch {
    toast("Could not load customer details.");
  }
}

function closeDrawer() {
  $("#drawerBackdrop").classList.add("hidden");
  $("#workspaceDrawer").classList.add("hidden");
}

function renderErrors() {
  const root = $("#errorTable");
  if (!state.errors.length) {
    root.innerHTML = `<div class="empty">No delivery failures recorded.</div>`;
    return;
  }

  root.innerHTML = `
    <table>
      <thead><tr><th>Time</th><th>Workspace</th><th>Instagram</th><th>Source</th><th>Code</th><th>Failure</th><th>Action</th></tr></thead>
      <tbody>${state.errors.map(item => `<tr><td>${escapeHtml(formatDate(item.occurred_at))}</td><td>${escapeHtml(item.workspace_name || "—")}</td><td>@${escapeHtml(item.instagram_username || "instagram")}</td><td>${escapeHtml(item.source)}</td><td class="mono">${escapeHtml(item.failure_code || "—")}</td><td class="error-text">${escapeHtml(item.failure_message || "—")}</td><td><button class="button small" data-retry-delivery="${escapeHtml(item.source)}" data-comment-id="${escapeHtml(item.comment_id)}">Retry</button></td></tr>`).join("")}</tbody>
    </table>`;

  $$("[data-retry-delivery]").forEach(button => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(
          `/api/admin/errors/${encodeURIComponent(button.dataset.retryDelivery)}/${encodeURIComponent(button.dataset.commentId)}/retry`,
          { method: "POST" }
        );
        toast("Retry queued.");
        await loadErrors();
      } catch (error) {
        toast(error.body?.error || "Retry failed.");
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function loadErrors() {
  try {
    const result = await api("/api/admin/errors?limit=100");
    state.errors = result.errors || [];
    renderErrors();
  } catch {
    toast("Could not load errors.");
  }
}

function renderSystem() {
  const data = state.system || {};
  const services = data.services || [];
  const tokens = data.tokens || [];
  const worker = services.find(item => item.service_name === "instagram-worker");
  const workerHealthy = worker && Number(worker.age_seconds) <= 90;

  $("#systemServices").innerHTML = `
    <div class="list">
      <div class="list-row"><div><strong>API</strong><small>${escapeHtml(data.api?.checkedAt || "—")}</small></div><span class="badge good">Healthy</span></div>
      <div class="list-row"><div><strong>Instagram worker</strong><small>${worker ? `${escapeHtml(worker.age_seconds)}s since heartbeat` : "No heartbeat yet"}</small></div><span class="badge ${workerHealthy ? "good" : "bad"}">${workerHealthy ? "Healthy" : "Needs attention"}</span></div>
    </div>`;

  $("#systemTokens").innerHTML = tokens.length
    ? `<div class="list">${tokens.map(item => {
        const expiry = item.token_expires_at ? new Date(item.token_expires_at) : null;
        const days = expiry ? Math.ceil((expiry.getTime() - Date.now()) / 86400000) : null;
        const cls = days === null || days <= 5 ? "bad" : days <= 14 ? "warn" : "good";
        return `<div class="list-row"><div><strong>@${escapeHtml(item.username || "instagram")}</strong><small>Expires ${escapeHtml(shortDate(item.token_expires_at))} · refreshed ${escapeHtml(shortDate(item.token_last_refreshed_at))}</small></div><span class="badge ${cls}">${days === null ? "Unknown" : `${days}d`}</span></div>`;
      }).join("")}</div>`
    : `<div class="empty">No connected tokens.</div>`;

  const queue = state.queue || {};
  const counts = queue.counts || data.queue || {};
  const failed = queue.failed || [];

  $("#systemQueue").innerHTML = `
    <div class="metric-grid">
      ${metricCard("Waiting", counts.waiting || 0, "Ready to process")}
      ${metricCard("Active", counts.active || 0, "Currently processing")}
      ${metricCard("Delayed", counts.delayed || 0, "Scheduled retries")}
      ${metricCard("Failed", counts.failed || 0, "Retained dead letters")}
      ${metricCard("Oldest pending", data.queue?.oldestPendingAgeSeconds == null ? "—" : `${data.queue.oldestPendingAgeSeconds}s`, "Queue age")}
    </div>
    ${failed.length ? `<div class="list">${failed.map(job => `
      <div class="list-row">
        <div>
          <strong>${escapeHtml(job.name)} · ${escapeHtml(job.id)}</strong>
          <small>${escapeHtml(job.failedReason || "Unknown failure")} · attempts ${escapeHtml(job.attemptsMade)}</small>
        </div>
        <button class="button small" data-retry-job="${escapeHtml(job.id)}">Retry job</button>
      </div>`).join("")}</div>` : `<div class="empty">No failed queue jobs.</div>`}
  `;

  $$("[data-retry-job]").forEach(button => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(
          `/api/admin/queue/${encodeURIComponent(button.dataset.retryJob)}/retry`,
          { method: "POST" }
        );
        toast("Queue job retried.");
        await loadSystem();
      } catch (error) {
        toast(error.body?.error || "Queue retry failed.");
      } finally {
        button.disabled = false;
      }
    });
  });

  const events = data.events || [];
  $("#systemEvents").innerHTML = events.length
    ? `<div class="list">${events.map(item => `
        <div class="list-row">
          <div>
            <strong>${escapeHtml(item.event_type)}</strong>
            <small>${escapeHtml(item.service_name)} · ${escapeHtml(formatDate(item.created_at))}<br>${escapeHtml(item.message || "")}</small>
          </div>
          <span class="badge ${["error","critical"].includes(item.severity) ? "bad" : item.severity === "warning" ? "warn" : "good"}">${escapeHtml(item.severity)}</span>
        </div>`).join("")}</div>`
    : `<div class="empty">No warning/error events in the last 24 hours.</div>`;

  renderOverviewSystem();
}

async function loadSystem() {
  try {
    const [system, queue] = await Promise.all([
      api("/api/admin/system"),
      api("/api/admin/queue")
    ]);
    state.system = system;
    state.queue = queue;
    renderSystem();
  } catch {
    toast("Could not load system status.");
  }
}

async function refreshCurrent() {
  try {
    if (state.currentPage === "overview") await loadOverview();
    if (state.currentPage === "workspaces") await loadWorkspaces($("#workspaceSearch")?.value || "");
    if (state.currentPage === "errors") await loadErrors();
    if (state.currentPage === "system") await loadSystem();
    toast("Refreshed.");
  } catch {
    toast("Refresh failed.");
  }
}

function bindEvents() {
  $$(".nav-item[data-page]").forEach(button => button.addEventListener("click", () => changePage(button.dataset.page)));
  $("#refreshButton").addEventListener("click", refreshCurrent);
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);

  let searchTimer;
  $("#workspaceSearch").addEventListener("input", event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadWorkspaces(event.target.value), 250);
  });
}

async function boot() {
  bindEvents();

  try {
    state.me = await api("/api/auth/me");
    if (state.me.user?.isSystemAdmin !== true) {
      $("#unauthorizedView").classList.remove("hidden");
      return;
    }

    $("#adminIdentity").textContent = state.me.user.displayName || state.me.user.email;
    $("#adminApp").classList.remove("hidden");
    await loadOverview();
  } catch (error) {
    $("#unauthorizedView").classList.remove("hidden");
    if (error.status !== 401 && error.status !== 403) toast("Admin console could not load.");
  }
}

boot();
