const state = {
  me: null,
  accounts: [],
  automations: [],
  activity: [],
  activitySummary: {},
  billingUsage: null,
  settings: null,
  sessions: [],
  analytics: null,
  analyticsRange: "7d",
  media: [],
  currentPage: "overview",
  editingAutomation: null
};

const $ = (selector) =>
  document.querySelector(selector);

const $$ = (selector) =>
  [...document.querySelectorAll(selector)];


async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",

    headers: {
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),

      ...(options.headers || {})
    },

    ...options
  });

  let body = null;

  const type =
    response.headers.get("content-type") || "";

  if (type.includes("application/json")) {
    body = await response.json();
  }

  if (!response.ok) {
    const error =
      new Error(
        body?.error ||
        `Request failed: ${response.status}`
      );

    error.status =
      response.status;

    error.body =
      body;

    throw error;
  }

  return body;
}


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

  toast.timer =
    setTimeout(() => {
      el.classList.add("hidden");
    }, 3000);
}



async function handleLaunchParams() {
  const params = new URLSearchParams(window.location.search);

  const invite = params.get("invite");
  if (invite) {
    try {
      const result = await api("/api/settings/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: invite })
      });
      toast(`Joined ${result.workspace?.name || "workspace"}.`);
      window.location.replace("/dashboard/?page=settings");
      return true;
    } catch (error) {
      toast(error.body?.error || "Invitation could not be accepted.");
      params.delete("invite");
    }
  }

  if (params.get("instagram") === "connected") {
    const username = params.get("username");
    toast(
      username
        ? `Instagram connected successfully — @${username} is ready.`
        : "Instagram connected successfully."
    );

    if (canEditWorkspace() && state.automations.length === 0) {
      changePage("automations");
      await openAutomationModal();
    } else {
      changePage("instagram");
    }

    params.delete("instagram");
    params.delete("username");
  }

  const requestedPage = params.get("page");
  if (["overview","automations","instagram","activity","analytics","plans","settings"].includes(requestedPage)) {
    changePage(requestedPage);
  }

  const next = params.toString();
  history.replaceState({}, "", next ? `${window.location.pathname}?${next}` : window.location.pathname);
  return false;
}

async function boot() {
  try {
    state.me =
      await api("/api/auth/me");

    showApp();

    await loadDashboard();

    await handleLaunchParams();

  } catch (error) {
    showLogin();
  }
}


function showLogin() {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
}


function showApp() {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");

  const user =
    state.me.user;

  const workspace =
    state.me.workspace;

  $("#profileName").textContent =
    user.displayName ||
    user.email;

  $("#profileRole").textContent =
    workspace.role;

  $("#sidebarWorkspace").textContent =
    workspace.name;

  $("#profileAvatar").textContent =
    (
      user.displayName ||
      user.email ||
      "R"
    )
      .charAt(0)
      .toUpperCase();

  $("#welcomeTitle").textContent =
    `Welcome back, ${
      user.displayName ||
      "there"
    }`;

  if (
    user.isSystemAdmin === true
  ) {
    $("#adminNav")
      ?.classList
      .remove("hidden");
  }

  const editable =
    ["owner", "admin"].includes(
      String(workspace.role || "")
    );

  [
    "#newAutomationTop",
    "#newAutomationWelcome",
    "#newAutomationButton",
    "#connectInstagramButton"
  ].forEach(selector => {
    $(selector)
      ?.classList
      .toggle(
        "hidden",
        !editable
      );
  });
}


async function loadDashboard() {
  try {
    const [
      accounts,
      automations,
      activity,
      billingUsage,
      settings
    ] =
      await Promise.all([
        api("/api/instagram/accounts"),
        api("/api/automations"),
        api("/api/activity?limit=100"),
        api("/api/billing/usage"),
        api("/api/settings")
      ]);

    state.accounts =
      accounts.accounts || [];

    state.automations =
      automations.automations || [];

    state.activity =
      activity.activity || [];

    state.activitySummary =
      activity.summary || {};

    state.billingUsage =
      billingUsage || null;

    state.settings =
      settings || null;

    renderAll();

  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }

    toast(
      "Could not refresh dashboard."
    );
  }
}


function renderAll() {
  renderOnboarding();
  renderWorkspaceAlerts();
  renderStats();
  renderPlanUsage();
  renderPlans();
  renderOverviewAutomations();
  renderOverviewAccounts();
  renderAutomations();
  renderAccounts();
  renderActivity();
}


function renderPlanUsage() {
  const root =
    $("#planUsage");

  if (!root) {
    return;
  }

  const billing =
    state.billingUsage;

  if (!billing) {
    root.innerHTML =
      `<div class="empty-state">
        Plan information unavailable.
      </div>`;

    return;
  }

  const planName =
    billing.plan?.name ||
    billing.plan?.code ||
    "Plan";

  const usage =
    billing.usage || {};

  const limits =
    billing.limits || {};

  const reached =
    billing.limitReached || {};

  function percent(current, limit) {
    const c =
      Number(current || 0);

    const l =
      Number(limit || 0);

    if (l <= 0) {
      return 0;
    }

    return Math.min(
      100,
      Math.round(
        (c / l) * 100
      )
    );
  }

  function usageRow({
    label,
    current,
    limit,
    limitReached
  }) {
    const pct =
      percent(
        current,
        limit
      );

    const warning =
      limitReached ||
      pct >= 80;

    return `
      <div class="usage-item">
        <div class="usage-row">
          <span>
            ${escapeHtml(label)}
          </span>

          <strong>
            ${escapeHtml(current)}
            /
            ${escapeHtml(limit)}
          </strong>
        </div>

        <div
          class="usage-track"
          aria-label="${escapeHtml(label)} usage"
        >
          <div
            class="usage-fill ${
              warning
                ? "warning"
                : ""
            }"
            style="width: ${pct}%"
          ></div>
        </div>

        ${
          limitReached
            ? `<small class="usage-warning">
                Limit reached
              </small>`
            : pct >= 80
              ? `<small class="usage-warning">
                  ${pct}% used
                </small>`
              : ""
        }
      </div>
    `;
  }

  const anyLimitReached =
    Boolean(
      reached.instagramAccounts ||
      reached.activeAutomations ||
      reached.monthlyDm
    );

  root.innerHTML = `
    <div class="plan-usage-header">
      <div>
        <span class="eyebrow">
          PLAN &amp; USAGE
        </span>

        <h3>
          ${escapeHtml(planName)}
          <span class="badge keyword">
            ${escapeHtml(
              billing.plan?.code || ""
            )}
          </span>
        </h3>

        <p>
          Current workspace limits and usage.
        </p>
      </div>

      ${
        anyLimitReached
          ? `<div class="plan-limit-notice">
              Upgrade to increase your limits.
            </div>`
          : ""
      }
    </div>

    <div class="usage-grid">
      ${usageRow({
        label:
          "Instagram accounts",

        current:
          usage.instagramAccounts || 0,

        limit:
          limits.instagramAccounts || 0,

        limitReached:
          reached.instagramAccounts
      })}

      ${usageRow({
        label:
          "Active automations",

        current:
          usage.activeAutomations || 0,

        limit:
          limits.activeAutomations || 0,

        limitReached:
          reached.activeAutomations
      })}

      ${usageRow({
        label:
          "Monthly DMs",

        current:
          usage.monthlyDm || 0,

        limit:
          limits.monthlyDm || 0,

        limitReached:
          reached.monthlyDm
      })}
    </div>
  `;
}


function renderOnboarding() {
  const root =
    $("#onboardingChecklist");

  if (!root) {
    return;
  }

  const hasConnectedAccount =
    state.accounts.some(
      account =>
        account.status === "connected"
    );

  const hasAutomation =
    state.automations.length > 0;

  const hasActiveAutomation =
    state.automations.some(
      automation =>
        automation.active
    );

  const hasSentDm =
    Number(
      state.activitySummary.dmSent || 0
    ) > 0;

  const steps = [
    {
      label:
        "Connect Instagram",
      done:
        hasConnectedAccount,
      action:
        "instagram"
    },
    {
      label:
        "Create your first automation",
      done:
        hasAutomation,
      action:
        "automation"
    },
    {
      label:
        "Activate the automation",
      done:
        hasActiveAutomation,
      action:
        "automations"
    },
    {
      label:
        "Send your first successful DM",
      done:
        hasSentDm,
      action:
        "activity"
    }
  ];

  if (
    steps.every(
      step => step.done
    )
  ) {
    root.classList.add(
      "hidden"
    );

    return;
  }

  root.classList.remove(
    "hidden"
  );

  const complete =
    steps.filter(
      step => step.done
    ).length;

  root.innerHTML = `
    <div class="onboarding-head">
      <div>
        <span class="eyebrow">
          GET STARTED
        </span>
        <h3>
          Launch your first automation
        </h3>
        <p>
          ${complete} of ${steps.length}
          setup steps complete.
        </p>
      </div>

      <strong class="onboarding-progress">
        ${Math.round(
          complete /
          steps.length *
          100
        )}%
      </strong>
    </div>

    <div class="onboarding-steps">
      ${steps.map(
        (step, index) => `
          <button
            class="onboarding-step ${
              step.done
                ? "done"
                : ""
            }"
            data-onboarding-action="${
              step.action
            }"
            type="button"
          >
            <span class="onboarding-check">
              ${
                step.done
                  ? "✓"
                  : index + 1
              }
            </span>
            <span>
              ${escapeHtml(
                step.label
              )}
            </span>
          </button>
        `
      ).join("")}
    </div>
  `;

  $$('[data-onboarding-action]')
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          const action =
            button.dataset
              .onboardingAction;

          if (
            action ===
            "automation"
          ) {
            openAutomationModal();
            return;
          }

          changePage(action);
        }
      );
    });
}

function renderWorkspaceAlerts() {
  const root =
    $("#workspaceAlerts");

  if (!root) {
    return;
  }

  const notifications =
    (state.settings?.notifications || [])
      .filter(item => !item.read_at)
      .slice(0, 5);

  if (!notifications.length) {
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }

  root.classList.remove("hidden");
  root.innerHTML = notifications.map(item => `
    <div class="workspace-alert ${escapeHtml(item.severity || "info")}">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.message)}</p>
      </div>
      <div class="workspace-alert-actions">
        ${item.action_url ? `<a class="button secondary" href="${escapeHtml(item.action_url)}">Review</a>` : ""}
        <button class="text-button" type="button" data-read-notification="${escapeHtml(item.id)}">Dismiss</button>
      </div>
    </div>
  `).join("");

  $$("[data-read-notification]")
    .forEach(button => {
      button.addEventListener("click", async () => {
        try {
          await api(
            `/api/settings/notifications/${encodeURIComponent(button.dataset.readNotification)}/read`,
            { method: "POST" }
          );

          const item =
            state.settings.notifications.find(
              entry =>
                String(entry.id) ===
                String(button.dataset.readNotification)
            );

          if (item) {
            item.read_at =
              new Date().toISOString();
          }

          renderWorkspaceAlerts();
        } catch {
          toast("Could not dismiss notification.");
        }
      });
    });
}


function renderStats() {
  const connected =
    state.accounts.filter(
      account =>
        account.status === "connected"
    ).length;

  const active =
    state.automations.filter(
      automation =>
        automation.active
    ).length;

  const attention =
    state.accounts.filter(
      account =>
        account.status !== "connected"
    ).length;

  $("#statAccounts").textContent =
    connected;

  $("#statActive").textContent =
    active;

  $("#statTotal").textContent =
    state.automations.length;

  $("#statAttention").textContent =
    attention;
}


function statusBadge(status) {
  if (status === "connected") {
    return `
      <span class="badge success">
        Connected
      </span>
    `;
  }

  if (status === "reauth_required") {
    return `
      <span class="badge danger">
        Reconnect
      </span>
    `;
  }

  return `
    <span class="badge muted">
      ${escapeHtml(status || "Unknown")}
    </span>
  `;
}


function renderOverviewAutomations() {
  const root =
    $("#overviewAutomations");

  const items =
    state.automations.slice(0, 5);

  if (!items.length) {
    root.innerHTML =
      `<div class="empty-state">
        No automations yet.
      </div>`;

    return;
  }

  root.innerHTML =
    items.map(item => `
      <div class="mini-row">
        <div class="mini-main">
          <strong>
            ${escapeHtml(
              item.instagram_username ||
              "Instagram"
            )}
          </strong>

          <span>
            ${escapeHtml(item.keyword)}
            → ${escapeHtml(
              item.destination_url
            )}
          </span>
        </div>

        <span class="badge ${
          item.active
            ? "success"
            : "muted"
        }">
          ${
            item.active
              ? "Active"
              : "Paused"
          }
        </span>
      </div>
    `).join("");
}


function renderOverviewAccounts() {
  const root =
    $("#overviewAccounts");

  if (!state.accounts.length) {
    root.innerHTML =
      `<div class="empty-state">
        No Instagram accounts.
      </div>`;

    return;
  }

  root.innerHTML =
    state.accounts
      .slice(0, 5)
      .map(account => `
        <div class="mini-row">
          <div class="mini-main">
            <strong>
              @${escapeHtml(
                account.username ||
                "instagram"
              )}
            </strong>

            <span>
              ${escapeHtml(
                account.account_type ||
                "Professional"
              )}
            </span>
          </div>

          ${statusBadge(account.status)}
        </div>
      `).join("");
}


function renderAutomations() {
  const root =
    $("#automationTable");

  if (!state.automations.length) {
    root.innerHTML =
      `<div class="empty-state">
        No automations yet.
      </div>`;

    return;
  }

  root.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Keyword</th>
          <th>Destination</th>
          <th>Match</th>
          <th>Status</th>
          <th>Public reply</th>
          <th></th>
        </tr>
      </thead>

      <tbody>
        ${state.automations.map(item => `
          <tr>
            <td>
              <strong>
                @${escapeHtml(
                  item.instagram_username ||
                  "instagram"
                )}
              </strong>
            </td>

            <td>
              <span class="badge keyword">
                ${escapeHtml(item.keyword)}
              </span>
            </td>

            <td>
              <div
                class="url-cell"
                title="${escapeHtml(
                  item.destination_url
                )}"
              >
                ${escapeHtml(
                  item.destination_url
                )}
              </div>
            </td>

            <td>
              ${escapeHtml(item.match_mode)}
            </td>

            <td>
              <span class="badge ${
                item.active
                  ? "success"
                  : "muted"
              }">
                ${
                  item.active
                    ? "Active"
                    : "Paused"
                }
              </span>
            </td>

            <td>
              ${
                item.public_reply_enabled
                  ? "On"
                  : "Off"
              }
            </td>

            <td>
              ${canEditWorkspace()
                ? `<div class="row-actions">
                    <button class="small-button" data-edit="${item.id}">Edit</button>
                    <button class="small-button" data-toggle="${item.id}">${item.active ? "Pause" : "Activate"}</button>
                    <button class="small-button danger" data-delete="${item.id}">Delete</button>
                  </div>`
                : `<span class="muted">Read only</span>`}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  $$("[data-edit]")
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          const automation =
            state.automations.find(
              item =>
                item.id ===
                button.dataset.edit
            );

          if (automation) {
            openAutomationModal(
              automation
            );
          }
        }
      );
    });

  $$("[data-toggle]")
    .forEach(button => {
      button.addEventListener(
        "click",
        () =>
          toggleAutomation(
            button.dataset.toggle
          )
      );
    });

  $$("[data-delete]")
    .forEach(button => {
      button.addEventListener(
        "click",
        () =>
          deleteAutomation(
            button.dataset.delete
          )
      );
    });
}


function renderAccounts() {
  const root =
    $("#accountsGrid");

  if (!state.accounts.length) {
    root.innerHTML =
      `<div class="empty-state">
        No Instagram accounts connected.
      </div>`;

    return;
  }

  root.innerHTML =
    state.accounts.map(account => {
      const expiryDate =
        account.token_expires_at
          ? new Date(
              account.token_expires_at
            )
          : null;

      const expiry =
        expiryDate
          ? expiryDate.toLocaleDateString()
          : "—";

      const expiryDays =
        expiryDate
          ? Math.ceil(
              (
                expiryDate.getTime() -
                Date.now()
              ) /
              86400000
            )
          : null;

      const health =
        account.status ===
        "reauth_required"
          ? "Reconnect required"
          : account.status !==
              "connected"
            ? "Disconnected"
            : expiryDays !== null &&
                expiryDays <= 14
              ? "Token expiring soon"
              : !account.comments_subscribed_at
                ? "Webhook not confirmed"
                : "Healthy";

      return `
        <article class="account-card">
          <div class="account-card-top">
            <div class="ig-icon">◎</div>

            ${statusBadge(account.status)}
          </div>

          <h3>
            @${escapeHtml(
              account.username ||
              "instagram"
            )}
          </h3>

          <p>
            ${escapeHtml(
              account.account_type ||
              "Professional account"
            )}
          </p>

          <div class="account-meta">
            <div class="account-meta-row">
              <span>Token expiry</span>
              <strong>${expiry}</strong>
            </div>

            <div class="account-meta-row">
              <span>Comments webhook</span>
              <strong>
                ${
                  account.comments_subscribed_at
                    ? "Subscribed"
                    : "—"
                }
              </strong>
            </div>

            <div class="account-meta-row">
              <span>Connection health</span>
              <strong>
                ${escapeHtml(health)}
              </strong>
            </div>

            <div class="account-meta-row">
              <span>Last token refresh</span>
              <strong>
                ${
                  account.token_last_refreshed_at
                    ? escapeHtml(
                        new Date(
                          account.token_last_refreshed_at
                        ).toLocaleDateString()
                      )
                    : "—"
                }
              </strong>
            </div>
          </div>

          ${
            account.status !== "connected"
              ? `
                <button
                  class="button secondary full"
                  data-reconnect-instagram="${account.id}"
                  type="button"
                >
                  Reconnect Instagram
                </button>
              `
              : ""
          }
        </article>
      `;
    }).join("");

  $$('[data-reconnect-instagram]')
    .forEach(button => {
      button.addEventListener(
        "click",
        connectInstagram
      );
    });
}



function activityBadge(status) {
  if (status === "sent") {
    return `
      <span class="badge success">
        Sent
      </span>
    `;
  }

  if (status === "failed") {
    return `
      <span class="badge danger">
        Failed
      </span>
    `;
  }

  if (
    status === "pending" ||
    status === "sending"
  ) {
    return `
      <span class="badge keyword">
        ${escapeHtml(status)}
      </span>
    `;
  }

  if (!status) {
    return `
      <span class="badge muted">
        —
      </span>
    `;
  }

  return `
    <span class="badge muted">
      ${escapeHtml(status)}
    </span>
  `;
}


function formatActivityTime(value) {
  if (!value) {
    return "—";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "—";
  }

  return date.toLocaleString();
}


function renderActivityFilters() {
  const select =
    $("#activityAccountFilter");

  if (!select) {
    return;
  }

  const previous =
    select.value;

  select.innerHTML =
    `<option value="">
      All Instagram accounts
    </option>` +
    state.accounts
      .map(account => `
        <option value="${account.id}">
          @${escapeHtml(
            account.username ||
            "instagram"
          )}
        </option>
      `)
      .join("");

  select.value =
    previous;
}


function renderActivity() {
  const root =
    $("#activityTable");

  if (!root) {
    return;
  }

  renderActivityFilters();

  $("#activityTotal").textContent =
    state.activitySummary.total || 0;

  $("#activityDmSent").textContent =
    state.activitySummary.dmSent || 0;

  $("#activityDmFailed").textContent =
    state.activitySummary.dmFailed || 0;

  $("#activityReplies").textContent =
    state.activitySummary
      .publicRepliesSent || 0;

  const accountFilter =
    $("#activityAccountFilter")
      ?.value || "";

  const statusFilter =
    $("#activityStatusFilter")
      ?.value || "";

  const rows =
    state.activity.filter(
      item => {
        if (
          accountFilter &&
          String(
            item.instagram_account_id
          ) !== accountFilter
        ) {
          return false;
        }

        if (
          statusFilter === "ignored"
        ) {
          return (
            item.comment_status ===
            "ignored"
          );
        }

        if (
          statusFilter &&
          item.dm_status !==
          statusFilter
        ) {
          return false;
        }

        return true;
      }
    );

  if (!rows.length) {
    root.innerHTML =
      `<div class="empty-state">
        No activity matches these filters.
      </div>`;

    return;
  }

  root.innerHTML = `
    <table class="data-table activity-table">
      <thead>
        <tr>
          <th>Instagram</th>
          <th>Commenter</th>
          <th>Comment</th>
          <th>Keyword</th>
          <th>DM</th>
          <th>Public reply</th>
          <th>Time</th>
        </tr>
      </thead>

      <tbody>
        ${rows.map(item => {
          const dmError =
            item.dm_failure_message ||
            item.comment_failure_message ||
            "";

          const replyError =
            item.public_reply_failure_message ||
            "";

          return `
            <tr>
              <td>
                <strong>
                  @${escapeHtml(
                    item.instagram_username ||
                    "instagram"
                  )}
                </strong>
              </td>

              <td>
                ${
                  item.commenter_username
                    ? `@${escapeHtml(
                        item.commenter_username
                      )}`
                    : "—"
                }
              </td>

              <td>
                <div
                  class="activity-comment"
                  title="${escapeHtml(
                    item.comment_text || ""
                  )}"
                >
                  ${escapeHtml(
                    item.comment_text || "—"
                  )}
                </div>
              </td>

              <td>
                ${
                  item.automation_keyword
                    ? `<span class="badge keyword">
                        ${escapeHtml(
                          item.automation_keyword
                        )}
                      </span>`
                    : "—"
                }
              </td>

              <td
                title="${escapeHtml(dmError)}"
              >
                ${activityBadge(
                  item.dm_status ||
                  item.comment_status
                )}
              </td>

              <td
                title="${escapeHtml(replyError)}"
              >
                ${activityBadge(
                  item.public_reply_status
                )}
              </td>

              <td>
                <span class="activity-time">
                  ${escapeHtml(
                    formatActivityTime(
                      item.received_at
                    )
                  )}
                </span>
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}


async function refreshActivity() {
  try {
    const result =
      await api(
        "/api/activity?limit=100"
      );

    state.activity =
      result.activity || [];

    state.activitySummary =
      result.summary || {};

    renderActivity();

    toast(
      "Activity refreshed."
    );

  } catch {
    toast(
      "Could not refresh activity."
    );
  }
}



async function loadAnalytics(
  range = state.analyticsRange
) {
  state.analyticsRange =
    range || "7d";

  try {
    const result =
      await api(
        `/api/analytics?range=${encodeURIComponent(
          state.analyticsRange
        )}`
      );

    state.analytics =
      result;

    state.analyticsRange =
      result?.range ||
      state.analyticsRange;

    renderAnalytics();

  } catch (error) {
    console.error(
      "Analytics load failed:",
      error
    );

    toast(
      "Could not load analytics."
    );
  }
}


function renderAnalytics() {
  const data =
    state.analytics;

  if (!data) {
    return;
  }

  const summary =
    data.summary || {};

  const commentsEl =
    $("#analyticsComments");

  const dmSentEl =
    $("#analyticsDmSent");

  const failuresEl =
    $("#analyticsFailures");

  const repliesEl =
    $("#analyticsReplies");

  const successEl =
    $("#analyticsSuccessRate");

  const matchedEl =
    $("#analyticsMatched");

  const conversionEl =
    $("#analyticsConversionRate");

  const latencyEl =
    $("#analyticsLatency");

  if (commentsEl) {
    commentsEl.textContent =
      Number(
        summary.commentsReceived || 0
      );
  }

  if (dmSentEl) {
    dmSentEl.textContent =
      Number(
        summary.dmSent || 0
      );
  }

  if (failuresEl) {
    failuresEl.textContent =
      Number(
        summary.dmFailed || 0
      );
  }

  if (repliesEl) {
    repliesEl.textContent =
      Number(
        summary.publicRepliesSent || 0
      );
  }

  if (successEl) {
    successEl.textContent =
      summary.dmSuccessRate == null
        ? "—"
        : `${summary.dmSuccessRate}%`;
  }

  if (matchedEl) {
    matchedEl.textContent =
      Number(
        summary.matchedComments || 0
      );
  }

  if (conversionEl) {
    conversionEl.textContent =
      summary.commentToDmRate == null
        ? "—"
        : `${summary.commentToDmRate}%`;
  }

  if (latencyEl) {
    const latency =
      Number(
        summary.avgDeliveryLatencyMs
      );

    latencyEl.textContent =
      Number.isFinite(latency) &&
      latency >= 0
        ? (
            latency < 1000
              ? `${Math.round(latency)} ms`
              : `${(latency / 1000).toFixed(1)} s`
          )
        : "—";
  }

  const historyDays =
    Number(
      state.billingUsage
        ?.limits
        ?.activityHistoryDays || 7
    );

  $$("[data-analytics-range]")
    .forEach(button => {
      const range =
        button.dataset.analyticsRange;

      const unavailable =
        range === "30d" &&
        historyDays < 30;

      button.disabled =
        unavailable;

      button.title =
        unavailable
          ? `Available on plans with at least 30 days of history.`
          : "";

      button.classList.toggle(
        "active",
        range ===
          state.analyticsRange
      );
    });

  renderAnalyticsChart(
    data.daily || []
  );

  renderAnalyticsAutomations(
    data.topAutomations || []
  );

  renderAnalyticsAccounts(
    data.accounts || []
  );

  renderAnalyticsMedia(
    data.topMedia || []
  );
}


function analyticsDayLabel(value) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date.toLocaleDateString(
    undefined,
    {
      month: "short",
      day: "numeric"
    }
  );
}


function renderAnalyticsChart(rows) {
  const root =
    $("#analyticsChart");

  if (!root) {
    return;
  }

  if (!rows.length) {
    root.innerHTML =
      `<div class="empty-state">
        No analytics data yet.
      </div>`;

    return;
  }

  const maxValue =
    Math.max(
      1,
      ...rows.flatMap(
        row => [
          Number(
            row.comments || 0
          ),
          Number(
            row.dm_sent || 0
          )
        ]
      )
    );

  root.innerHTML =
    rows.map(row => {
      const comments =
        Number(
          row.comments || 0
        );

      const dmSent =
        Number(
          row.dm_sent || 0
        );

      const commentHeight =
        comments > 0
          ? Math.max(
              6,
              comments /
              maxValue *
              100
            )
          : 0;

      const dmHeight =
        dmSent > 0
          ? Math.max(
              6,
              dmSent /
              maxValue *
              100
            )
          : 0;

      const label =
        analyticsDayLabel(
          row.day
        );

      return `
        <div
          class="chart-column"
          title="${escapeHtml(
            `${label}: ${comments} comments, ${dmSent} DMs sent`
          )}"
        >
          <div class="chart-bars">
            <span
              class="chart-bar comments"
              style="height:${commentHeight}%"
            ></span>

            <span
              class="chart-bar sent"
              style="height:${dmHeight}%"
            ></span>
          </div>

          <span class="chart-date">
            ${escapeHtml(label)}
          </span>
        </div>
      `;
    }).join("");
}


function renderAnalyticsAutomations(rows) {
  const root =
    $("#analyticsAutomations");

  if (!root) {
    return;
  }

  if (!rows.length) {
    root.innerHTML =
      `<div class="empty-state">
        No automation data yet.
      </div>`;

    return;
  }

  const maxSent =
    Math.max(
      1,
      ...rows.map(
        row =>
          Number(
            row.dm_sent || 0
          )
      )
    );

  root.innerHTML =
    rows.map(
      (row, index) => {
        const sent =
          Number(
            row.dm_sent || 0
          );

        const failed =
          Number(
            row.dm_failed || 0
          );

        const width =
          sent /
          maxSent *
          100;

        return `
          <div class="ranking-row">
            <div class="ranking-number">
              ${index + 1}
            </div>

            <div class="ranking-main">
              <div class="ranking-title">
                <strong>
                  ${escapeHtml(
                    row.keyword || "—"
                  )}
                </strong>

                <span>
                  ${sent} sent
                </span>
              </div>

              <div class="ranking-subtitle">
                @${escapeHtml(
                  row.instagram_username ||
                  "instagram"
                )}
                · ${failed} failed
              </div>

              <div class="ranking-track">
                <span
                  style="width:${width}%"
                ></span>
              </div>
            </div>
          </div>
        `;
      }
    ).join("");
}


function renderAnalyticsAccounts(rows) {
  const root =
    $("#analyticsAccounts");

  if (!root) {
    return;
  }

  if (!rows.length) {
    root.innerHTML =
      `<div class="empty-state">
        No account data yet.
      </div>`;

    return;
  }

  root.innerHTML =
    rows.map(row => {
      const comments =
        Number(
          row.comments_received || 0
        );

      const sent =
        Number(
          row.dm_sent || 0
        );

      const failed =
        Number(
          row.dm_failed || 0
        );

      return `
        <div class="ranking-row">
          <div class="ig-mini">
            ◎
          </div>

          <div class="ranking-main">
            <div class="ranking-title">
              <strong>
                @${escapeHtml(
                  row.username ||
                  "instagram"
                )}
              </strong>

              <span>
                ${sent} sent
              </span>
            </div>

            <div class="account-metrics">
              <span>
                ${comments} comments
              </span>

              <span>
                ${failed} failed
              </span>
            </div>
          </div>
        </div>
      `;
    }).join("");
}


function renderAnalyticsMedia(rows) {
  const root =
    $("#analyticsMedia");

  if (!root) {
    return;
  }

  if (!rows.length) {
    root.innerHTML =
      `<div class="empty-state">
        No post or reel performance yet.
      </div>`;
    return;
  }

  root.innerHTML =
    rows.map(row => {
      const comments =
        Number(
          row.comments_received || 0
        );
      const matched =
        Number(
          row.matched_comments || 0
        );
      const sent =
        Number(
          row.dm_sent || 0
        );
      const failed =
        Number(
          row.dm_failed || 0
        );
      const rate =
        matched > 0
          ? Math.round(
              sent / matched * 100
            )
          : 0;
      const latency =
        row.avg_delivery_latency_ms == null
          ? "—"
          : (
              Number(row.avg_delivery_latency_ms) < 1000
                ? `${Math.round(Number(row.avg_delivery_latency_ms))} ms`
                : `${(Number(row.avg_delivery_latency_ms) / 1000).toFixed(1)} s`
            );

      return `
        <div class="ranking-row">
          <div class="ig-mini">▣</div>
          <div class="ranking-main">
            <div class="ranking-title">
              <strong>
                @${escapeHtml(row.instagram_username || "instagram")}
                · ${escapeHtml(String(row.instagram_media_id || "").slice(-10))}
              </strong>
              <span>${sent} sent · ${rate}% matched→DM</span>
            </div>
            <div class="account-metrics">
              <span>${comments} comments</span>
              <span>${matched} matched</span>
              <span>${failed} failed</span>
              <span>${escapeHtml(latency)} avg</span>
            </div>
          </div>
        </div>
      `;
    }).join("");
}


function renderPlans() {
  const billing =
    state.billingUsage;

  if (!billing) {
    return;
  }

  const currentPlan =
    String(
      billing.plan?.code || ""
    ).toLowerCase();

  $$("[data-plan-card]")
    .forEach(card => {
      const code =
        card.dataset.planCard;

      card.classList.toggle(
        "current",
        code === currentPlan
      );
    });

  $$("[data-current-plan]")
    .forEach(badge => {
      badge.classList.toggle(
        "hidden",
        badge.dataset.currentPlan !==
          currentPlan
      );
    });

  $$("[data-plan-action]")
    .forEach(button => {
      const code =
        button.dataset.planAction;

      const isCurrent =
        code === currentPlan;

      button.disabled =
        isCurrent;

      if (isCurrent) {
        button.textContent =
          "Current plan";

        return;
      }

      if (code === "free") {
        button.textContent =
          "Free plan";

        return;
      }

      const commercial =
        billing.commercial || {};

      const target =
        commercial.purchaseUrl ||
        commercial.contactUrl ||
        null;

      if (
        commercial.mode ===
        "private_beta"
      ) {
        button.textContent =
          target
            ? "Contact us for access"
            : "Private beta";

        button.disabled =
          !target;

        button.onclick =
          target
            ? () =>
                window.location.assign(
                  target
                )
            : null;

        return;
      }

      button.textContent =
        target
          ? "Upgrade"
          : "Contact us";

      button.disabled =
        !target;

      button.onclick =
        target
          ? () =>
              window.location.assign(
                target
              )
          : null;
    });
}


function canEditWorkspace() {
  return ["owner", "admin"].includes(
    String(state.me?.workspace?.role || "")
  );
}

function renderSettings() {
  const user = state.me?.user || {};
  const workspace = state.me?.workspace || {};
  const settings = state.settings || {};
  const ws = settings.workspace || {};
  const permissions = settings.permissions || {};

  $("#settingsEmail").textContent = user.email || "—";
  $("#settingsWorkspace").textContent = ws.name || workspace.name || "—";
  $("#settingsRole").textContent = workspace.role || "—";

  if ($("#workspaceName")) {
    $("#workspaceName").value = ws.name || workspace.name || "";
    $("#workspaceTimezone").value = ws.timezone || "UTC";
    $("#workspaceNotificationEmail").value = ws.notification_email || "";
    $("#notifyTokenExpiry").checked = ws.notify_token_expiry !== false;
    $("#notifyFailures").checked = ws.notify_failures !== false;

    $$("#workspaceSettingsForm input, #workspaceSettingsForm select, #workspaceSettingsForm button")
      .forEach(el => {
        el.disabled = permissions.editWorkspace !== true;
      });
  }

  const root = $("#sessionList");
  if (root) {
    root.innerHTML = state.sessions.length
      ? state.sessions.map(session => `
          <div class="settings-session-row">
            <div>
              <strong>${escapeHtml(session.device_label || (session.is_current ? "Current device" : "Unknown device"))}</strong>
              <span>
                ${session.ip_address ? `${escapeHtml(session.ip_address)} · ` : ""}
                created ${escapeHtml(formatActivityTime(session.created_at))}
                · last seen ${escapeHtml(formatActivityTime(session.last_seen_at))}
                · expires ${escapeHtml(formatActivityTime(session.expires_at))}
              </span>
            </div>
            <div class="settings-session-actions">
              <span class="badge ${session.is_current ? "success" : "muted"}">
                ${session.is_current ? "This device" : "Active"}
              </span>
              ${session.is_current ? "" : `<button class="button secondary compact" type="button" data-revoke-session="${escapeHtml(session.id)}">Revoke</button>`}
            </div>
          </div>`).join("")
      : `<div class="empty-state">No active sessions.</div>`;

    $$('[data-revoke-session]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/auth/sessions/${encodeURIComponent(button.dataset.revokeSession)}/revoke`, {
            method: 'POST',
            body: JSON.stringify({})
          });
          toast('Session revoked.');
          await loadSettings();
        } catch (error) {
          toast(error.body?.error || 'Could not revoke session.');
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  const membersRoot = $("#teamMembers");
  if (membersRoot) {
    const members = settings.members || [];
    membersRoot.innerHTML = members.length
      ? `<div class="settings-list"><h4>Members</h4>${members.map(member => {
          const owner = member.role === 'owner';
          const canManageRole = permissions.manageRoles === true && !owner;
          const canRemove = !owner && member.id !== user.id && (
            permissions.manageRoles === true ||
            (workspace.role === 'admin' && member.role === 'member')
          );
          return `<div class="settings-session-row">
            <div>
              <strong>${escapeHtml(member.display_name || member.email)}</strong>
              <span>${escapeHtml(member.email)} · ${escapeHtml(member.status)}</span>
            </div>
            <div class="settings-session-actions">
              ${canManageRole ? `<select class="team-role-select" data-member-role="${escapeHtml(member.id)}"><option value="member" ${member.role === 'member' ? 'selected' : ''}>Member</option><option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option></select>` : `<span class="badge muted">${escapeHtml(member.role)}</span>`}
              ${canRemove ? `<button class="button secondary compact" type="button" data-remove-member="${escapeHtml(member.id)}">Remove</button>` : ''}
            </div>
          </div>`;
        }).join('')}</div>`
      : `<div class="empty-state">No workspace members.</div>`;

    $$('[data-member-role]').forEach(select => {
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await api(`/api/settings/team/members/${encodeURIComponent(select.dataset.memberRole)}`, {
            method: 'PATCH',
            body: JSON.stringify({ role: select.value })
          });
          toast('Member role updated.');
          await loadSettings();
        } catch (error) {
          toast(error.body?.error || 'Could not update role.');
          await loadSettings();
        }
      });
    });

    $$('[data-remove-member]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/settings/team/members/${encodeURIComponent(button.dataset.removeMember)}`, {
            method: 'DELETE',
            body: JSON.stringify({})
          });
          toast('Member removed.');
          await loadSettings();
        } catch (error) {
          toast(error.body?.error || 'Could not remove member.');
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  const invitationsRoot = $("#teamInvitations");
  if (invitationsRoot) {
    const invitations = settings.invitations || [];
    invitationsRoot.innerHTML = invitations.length
      ? `<div class="settings-list"><h4>Pending invitations</h4>${invitations.map(invite => `<div class="settings-session-row"><div><strong>${escapeHtml(invite.email)}</strong><span>${escapeHtml(invite.role)} · expires ${escapeHtml(formatActivityTime(invite.expires_at))}</span></div><button class="button secondary compact" type="button" data-revoke-invite="${escapeHtml(invite.id)}">Revoke</button></div>`).join('')}</div>`
      : '';

    $$('[data-revoke-invite]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/settings/team/invitations/${encodeURIComponent(button.dataset.revokeInvite)}`, {
            method: 'DELETE',
            body: JSON.stringify({})
          });
          toast('Invitation revoked.');
          await loadSettings();
        } catch (error) {
          toast(error.body?.error || 'Could not revoke invitation.');
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  const inviteForm = $("#teamInviteForm");
  if (inviteForm) {
    const enabled = permissions.inviteMembers === true;
    $$(`#teamInviteForm input, #teamInviteForm select, #teamInviteForm button`)
      .forEach(el => { el.disabled = !enabled; });
    if (workspace.role !== 'owner' && $("#teamInviteRole")) {
      $("#teamInviteRole").value = 'member';
      $("#teamInviteRole").disabled = true;
    }
  }
}

async function loadSettings() {
  try {
    const [sessions, settings] = await Promise.all([
      api("/api/auth/sessions"),
      api("/api/settings")
    ]);
    state.sessions = sessions.sessions || [];
    state.settings = settings || null;
    if (settings?.workspace?.name && state.me?.workspace) {
      state.me.workspace.name = settings.workspace.name;
      $("#sidebarWorkspace").textContent = settings.workspace.name;
    }
    renderWorkspaceAlerts();
    renderSettings();
  } catch {
    toast("Could not load account settings.");
  }
}

async function saveWorkspaceSettings(event) {
  event.preventDefault();
  try {
    const result = await api('/api/settings/workspace', {
      method: 'PATCH',
      body: JSON.stringify({
        name: $("#workspaceName").value.trim(),
        timezone: $("#workspaceTimezone").value.trim(),
        notificationEmail: $("#workspaceNotificationEmail").value.trim(),
        notifyTokenExpiry: $("#notifyTokenExpiry").checked,
        notifyFailures: $("#notifyFailures").checked
      })
    });
    if (state.settings) state.settings.workspace = result.workspace;
    if (state.me?.workspace) state.me.workspace.name = result.workspace.name;
    $("#sidebarWorkspace").textContent = result.workspace.name;
    toast('Workspace settings saved.');
    renderSettings();
  } catch (error) {
    toast(error.body?.error || 'Could not save workspace settings.');
  }
}

async function createTeamInvitation(event) {
  event.preventDefault();
  try {
    const result = await api('/api/settings/team/invitations', {
      method: 'POST',
      body: JSON.stringify({
        email: $("#teamInviteEmail").value.trim(),
        role: $("#teamInviteRole").value
      })
    });
    $("#teamInviteForm").reset();
    const inviteUrl = new URL(result.inviteUrl, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast('Invitation created and link copied.');
    } catch {
      toast(`Invitation created: ${inviteUrl}`);
    }
    await loadSettings();
  } catch (error) {
    toast(error.body?.error || 'Could not create invitation.');
  }
}

async function changePassword(event) {
  event.preventDefault();

  const currentPassword = $("#currentPassword").value;
  const newPassword = $("#newPassword").value;
  const confirmNewPassword = $("#confirmNewPassword").value;

  if (newPassword.length < 12) {
    toast("New password must be at least 12 characters.");
    return;
  }

  if (newPassword !== confirmNewPassword) {
    toast("New passwords do not match.");
    return;
  }

  try {
    const result = await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword,
        newPassword
      })
    });

    $("#changePasswordForm").reset();
    await loadSettings();

    toast(
      result.revokedOtherSessions
        ? `Password changed. ${result.revokedOtherSessions} other session(s) signed out.`
        : "Password changed successfully."
    );
  } catch (error) {
    const code = error.body?.error;

    if (code === "current_password_incorrect") {
      toast("Current password is incorrect.");
      return;
    }

    if (code === "password_too_short") {
      toast("New password must be at least 12 characters.");
      return;
    }

    if (code === "password_must_change") {
      toast("Choose a different new password.");
      return;
    }

    toast("Could not change password.");
  }
}

async function revokeOtherSessions() {
  try {
    const result = await api("/api/auth/sessions/revoke-others", {
      method: "POST",
      body: JSON.stringify({})
    });

    await loadSettings();

    toast(
      result.revokedSessions
        ? `${result.revokedSessions} other session(s) signed out.`
        : "No other active sessions."
    );
  } catch {
    toast("Could not sign out other sessions.");
  }
}


function changePage(page) {
  state.currentPage = page;

  $$(".page")
    .forEach(el =>
      el.classList.add("hidden")
    );

  $(`#page-${page}`)
    ?.classList
    .remove("hidden");

  $$(".nav-item[data-page]")
    .forEach(el => {
      el.classList.toggle(
        "active",
        el.dataset.page === page
      );
    });

  const titles = {
    overview: [
      "Overview",
      "Your Instagram automation workspace."
    ],

    automations: [
      "Automations",
      "Build and manage comment-to-DM flows."
    ],

    instagram: [
      "Instagram",
      "Manage connected Professional accounts."
    ],

    activity: [
      "Activity",
      "Track comments, DMs and public replies."
    ],

    plans: [
      "Plans",
      "Compare your workspace limits and upgrade options."
    ],

    settings: [
      "Settings",
      "Manage account security and active sessions."
    ]
  };

  const pageMeta =
    page === "analytics"
      ? [
          "Analytics",
          "Measure comment and DM performance."
        ]
      : (
          titles[page] || [
            "Overview",
            "Your Instagram automation workspace."
          ]
        );

  $("#pageTitle").textContent =
    pageMeta[0];

  $("#pageSubtitle").textContent =
    pageMeta[1];

  if (page === "analytics") {
    loadAnalytics(
      state.analyticsRange
    );
  }

  if (page === "settings") {
    loadSettings();
  }
}


function fillAccountSelect() {
  const select =
    $("#automationAccount");

  const connected =
    state.accounts.filter(
      account =>
        account.status === "connected"
    );

  select.innerHTML =
    connected.map(account => `
      <option value="${account.id}">
        @${escapeHtml(account.username)}
      </option>
    `).join("");
}


async function loadMedia(
  accountId,
  selectedMediaId = null
) {
  const picker =
    $("#mediaPicker");

  picker.innerHTML =
    `<div class="empty-state compact">
      Loading posts and reels…
    </div>`;

  try {
    const result =
      await api(
        `/api/instagram/accounts/${accountId}/media`
      );

    state.media =
      result.media || [];

    if (!state.media.length) {
      picker.innerHTML =
        `<div class="empty-state compact">
          No media found.
        </div>`;

      return;
    }

    picker.innerHTML =
      state.media.map(media => {
        const image =
          media.thumbnailUrl ||
          media.mediaUrl;

        const selected =
          String(media.id) ===
          String(selectedMediaId);

        return `
          <div
            class="media-card ${
              selected
                ? "selected"
                : ""
            }"
            data-media="${media.id}"
            title="${escapeHtml(
              media.caption || ""
            )}"
          >
            ${
              image
                ? `<img
                    src="${escapeHtml(image)}"
                    alt=""
                    loading="lazy"
                  >`
                : `<div class="media-placeholder">
                    ${escapeHtml(
                      media.mediaType ||
                      "Media"
                    )}
                  </div>`
            }

            <span class="media-type">
              ${escapeHtml(
                media.mediaType ||
                "MEDIA"
              )}
            </span>
          </div>
        `;
      }).join("");

    $$(".media-card")
      .forEach(card => {
        card.addEventListener(
          "click",
          () => {
            $$(".media-card")
              .forEach(item =>
                item.classList
                  .remove("selected")
              );

            card.classList.add(
              "selected"
            );

            $("#selectedMediaId")
              .value =
                card.dataset.media;
          }
        );
      });

    if (selectedMediaId) {
      $("#selectedMediaId").value =
        selectedMediaId;
    }

  } catch (error) {
    picker.innerHTML =
      `<div class="empty-state compact">
        Could not load Instagram media.
      </div>`;
  }
}


async function openAutomationModal(
  automation = null
) {
  state.editingAutomation =
    automation;

  fillAccountSelect();

  $("#automationForm").reset();

  $("#automationId").value =
    automation?.id || "";

  $("#modalTitle").textContent =
    automation
      ? "Edit automation"
      : "Create automation";

  $("#automationKeyword").value =
    automation?.keyword || "";

  $("#destinationUrl").value =
    automation?.destination_url || "";

  $("#dmTemplate").value =
    automation?.dm_template ||
    "Thanks! Here is your link 👇 {{url}}";

  $("#matchMode").value =
    automation?.match_mode ||
    "exact";

  $("#publicReplyEnabled").checked =
    Boolean(
      automation?.public_reply_enabled
    );

  $("#publicReplyTemplate").value =
    automation?.public_reply_template ||
    "Sent it in DM 📩 If you don't see it, check Message Requests.";

  togglePublicReplyField();

  let accountId =
    automation?.instagram_account_id ||
    state.accounts.find(
      account =>
        account.status === "connected"
    )?.id;

  if (accountId) {
    $("#automationAccount").value =
      accountId;

    await loadMedia(
      accountId,
      automation?.instagram_media_id ||
      null
    );
  }

  $("#automationModal")
    .classList.remove("hidden");
}


function closeAutomationModal() {
  $("#automationModal")
    .classList.add("hidden");

  state.editingAutomation = null;
  state.media = [];
}


function togglePublicReplyField() {
  $("#publicReplyField")
    .classList.toggle(
      "hidden",
      !$("#publicReplyEnabled").checked
    );
}


async function saveAutomation(event) {
  event.preventDefault();

  const id =
    $("#automationId").value;

  const accountId =
    $("#automationAccount").value;

  const mediaId =
    $("#selectedMediaId").value;

  if (!mediaId) {
    toast(
      "Choose a post or reel first."
    );
    return;
  }

  const body = {
    instagramAccountId:
      accountId,

    instagramMediaId:
      mediaId,

    keyword:
      $("#automationKeyword")
        .value.trim(),

    destinationUrl:
      $("#destinationUrl")
        .value.trim(),

    dmTemplate:
      $("#dmTemplate")
        .value.trim(),

    matchMode:
      $("#matchMode").value,

    publicReplyEnabled:
      $("#publicReplyEnabled")
        .checked,

    publicReplyTemplate:
      $("#publicReplyEnabled")
        .checked
          ? $("#publicReplyTemplate")
              .value.trim()
          : null
  };

  const button =
    $("#saveAutomationButton");

  button.disabled = true;
  button.textContent =
    id ? "Updating…" : "Creating…";

  try {
    if (id) {
      const {
        instagramAccountId,
        ...updateBody
      } = body;

      await api(
        `/api/automations/${id}`,
        {
          method: "PATCH",
          body:
            JSON.stringify(
              updateBody
            )
        }
      );

      toast("Automation updated.");

    } else {
      await api(
        "/api/automations",
        {
          method: "POST",
          body:
            JSON.stringify(body)
        }
      );

      toast("Automation created.");
    }

    closeAutomationModal();
    await loadDashboard();

  } catch (error) {
    if (
      error.body?.error ===
      "subscription_inactive"
    ) {
      const status =
        String(
          error.body.status || "inactive"
        );

      toast(
        `Subscription is ${status}. Automation activation is unavailable.`
      );

    } else if (
      error.body?.error ===
      "instagram_account_not_connected"
    ) {
      toast(
        "Reconnect the Instagram account before activating this automation."
      );

    } else if (
      error.body?.error ===
      "active_automation_limit_reached"
    ) {
      if (
        error.body.limit === undefined
      ) {
        toast(
          "Your plan's active automation limit has been reached."
        );

        return;
      }

      const plan =
        String(
          error.body.plan || "current"
        );

      const planName =
        plan.charAt(0).toUpperCase() +
        plan.slice(1);

      const current =
        Number(
          error.body.current || 0
        );

      const limit =
        Number(
          error.body.limit || 0
        );

      toast(
        `${planName} plan allows ${limit} active automation${limit === 1 ? "" : "s"}. ` +
        `You currently have ${current} active. Upgrade to activate more.`
      );

    } else if (
      error.message ===
      "active_trigger_already_exists"
    ) {
      toast(
        "That keyword is already active for this post."
      );

    } else {
      toast(
        "Could not save automation."
      );
    }

  } finally {
    button.disabled = false;
    button.textContent =
      "Save automation";
  }
}


async function toggleAutomation(id) {
  const automation =
    state.automations.find(
      item => item.id === id
    );

  if (!automation) {
    return;
  }

  try {
    await api(
      `/api/automations/${id}`,
      {
        method: "PATCH",

        body:
          JSON.stringify({
            active:
              !automation.active
          })
      }
    );

    toast(
      automation.active
        ? "Automation paused."
        : "Automation activated."
    );

    await loadDashboard();

  } catch (error) {
    if (
      error.body?.error ===
      "subscription_inactive"
    ) {
      const status =
        String(
          error.body.status || "inactive"
        );

      toast(
        `Subscription is ${status}. Automation activation is unavailable.`
      );

      return;
    }

    if (
      error.body?.error ===
      "instagram_account_not_connected"
    ) {
      toast(
        "Reconnect the Instagram account before activating this automation."
      );

      return;
    }

    if (
      error.body?.error ===
      "active_automation_limit_reached"
    ) {
      if (
        error.body.limit === undefined
      ) {
        toast(
          "Your plan's active automation limit has been reached."
        );

        return;
      }

      const plan =
        String(
          error.body.plan || "current"
        );

      const planName =
        plan.charAt(0).toUpperCase() +
        plan.slice(1);

      const current =
        Number(
          error.body.current || 0
        );

      const limit =
        Number(
          error.body.limit || 0
        );

      toast(
        `${planName} plan allows ${limit} active automation${limit === 1 ? "" : "s"}. ` +
        `You currently have ${current} active. Upgrade to activate more.`
      );

      return;
    }

    toast(
      "Could not update automation."
    );
  }
}


async function deleteAutomation(id) {
  const automation =
    state.automations.find(
      item => item.id === id
    );

  if (!automation) {
    return;
  }

  if (
    !confirm(
      `Delete automation "${automation.keyword}"?`
    )
  ) {
    return;
  }

  try {
    await api(
      `/api/automations/${id}`,
      {
        method: "DELETE"
      }
    );

    toast("Automation deleted.");

    await loadDashboard();

  } catch {
    toast(
      "Could not delete automation."
    );
  }
}


async function login(event) {
  event.preventDefault();

  const button =
    $("#loginButton");

  const errorEl =
    $("#loginError");

  errorEl.textContent = "";

  button.disabled = true;
  button.textContent =
    "Signing in…";

  try {
    state.me =
      await api(
        "/api/auth/login",
        {
          method: "POST",

          body:
            JSON.stringify({
              email:
                $("#loginEmail")
                  .value.trim(),

              password:
                $("#loginPassword")
                  .value
            })
        }
      );

    $("#loginPassword").value = "";

    showApp();
    await loadDashboard();
    await handleLaunchParams();

  } catch (error) {
    errorEl.textContent =
      "Incorrect email or password.";

  } finally {
    button.disabled = false;
    button.textContent =
      "Sign in";
  }
}


async function logout() {
  try {
    await api(
      "/api/auth/logout",
      {
        method: "POST"
      }
    );
  } catch {}

  state.me = null;
  state.accounts = [];
  state.automations = [];

  showLogin();
}



async function connectInstagram() {
  const button =
    $("#connectInstagramButton");

  if (!button) {
    return;
  }

  const originalText =
    button.textContent;

  button.disabled = true;
  button.textContent =
    "Connecting…";

  try {
    const result =
      await api(
        "/api/instagram/accounts/connect",
        {
          method: "POST"
        }
      );

    if (!result?.authorizationUrl) {
      throw new Error(
        "authorization_url_missing"
      );
    }

    window.location.assign(
      result.authorizationUrl
    );

  } catch (error) {
    button.disabled = false;
    button.textContent =
      originalText;

    if (
      error.body?.error ===
      "subscription_inactive"
    ) {
      const status =
        String(
          error.body.status || "inactive"
        );

      toast(
        `Subscription is ${status}. Connecting another Instagram account is unavailable.`
      );

      return;
    }

    if (
      error.body?.error ===
      "instagram_account_limit_reached"
    ) {
      const plan =
        String(
          error.body.plan || "current"
        );

      const planName =
        plan.charAt(0).toUpperCase() +
        plan.slice(1);

      const current =
        Number(
          error.body.current || 0
        );

      const limit =
        Number(
          error.body.limit || 0
        );

      toast(
        `${planName} plan allows ${limit} Instagram account${limit === 1 ? "" : "s"}. ` +
        `You currently have ${current} connected. Upgrade to connect another account.`
      );

      return;
    }

    toast(
      "Could not start Instagram connection."
    );
  }
}

function bindEvents() {

  $("#workspaceSettingsForm")
    ?.addEventListener(
      "submit",
      saveWorkspaceSettings
    );

  $("#teamInviteForm")
    ?.addEventListener(
      "submit",
      createTeamInvitation
    );

  $("#changePasswordForm")
    ?.addEventListener(
      "submit",
      changePassword
    );

  $("#revokeOtherSessions")
    ?.addEventListener(
      "click",
      revokeOtherSessions
    );

  $("#connectInstagramButton")
    ?.addEventListener(
      "click",
      connectInstagram
    );

  $("#refreshActivityButton")
    ?.addEventListener(
      "click",
      refreshActivity
    );

  $("#activityAccountFilter")
    ?.addEventListener(
      "change",
      renderActivity
    );

  $("#activityStatusFilter")
    ?.addEventListener(
      "change",
      renderActivity
    );

  $("#loginForm")
    .addEventListener(
      "submit",
      login
    );

  $("#logoutButton")
    .addEventListener(
      "click",
      logout
    );

  $("#refreshButton")
    .addEventListener(
      "click",
      async () => {
        await loadDashboard();
        toast("Dashboard refreshed.");
      }
    );

  $$("[data-analytics-range]")
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          if (button.disabled) {
            return;
          }

          loadAnalytics(
            button.dataset.analyticsRange
          );
        }
      );
    });

  $$(".nav-item[data-page]")
    .forEach(button => {
      button.addEventListener(
        "click",
        () =>
          changePage(
            button.dataset.page
          )
      );
    });

  $$("[data-go]")
    .forEach(button => {
      button.addEventListener(
        "click",
        () =>
          changePage(
            button.dataset.go
          )
      );
    });

  [
    "#newAutomationTop",
    "#newAutomationWelcome",
    "#newAutomationButton"
  ].forEach(selector => {
    $(selector)
      ?.addEventListener(
        "click",
        () =>
          openAutomationModal()
      );
  });

  $("#closeModal")
    .addEventListener(
      "click",
      closeAutomationModal
    );

  $("#cancelModal")
    .addEventListener(
      "click",
      closeAutomationModal
    );

  $("#automationModal")
    .addEventListener(
      "click",
      event => {
        if (
          event.target ===
          $("#automationModal")
        ) {
          closeAutomationModal();
        }
      }
    );

  $("#automationAccount")
    .addEventListener(
      "change",
      event => {
        $("#selectedMediaId").value =
          "";

        loadMedia(
          event.target.value
        );
      }
    );

  $("#publicReplyEnabled")
    .addEventListener(
      "change",
      togglePublicReplyField
    );

  $("#automationForm")
    .addEventListener(
      "submit",
      saveAutomation
    );
}


document.addEventListener(
  "DOMContentLoaded",
  () => {
    bindEvents();
    boot();
  }
);
