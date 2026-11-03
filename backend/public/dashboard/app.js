(() => {
  "use strict";

  const API = "/api/v1";
  const STAFF_ROLES = new Set(["ADMIN", "SUPER_ADMIN", "DISPATCHER"]);
  let session = null;
  let refreshInFlight = null;
  let toastTimer = null;

  const $ = (selector) => document.querySelector(selector);
  const setText = (selector, value) => {
    const element = $(selector);
    if (element) element.textContent = value;
  };

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options });
    let body = null;
    try { body = await response.json(); } catch { /* An unavailable API may not return JSON. */ }
    return { response, body };
  }

  async function rotateSession() {
    if (!session?.refreshToken) return false;
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const { response, body } = await fetchJson(`${API}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        if (!response.ok || !body?.data?.accessToken || !body?.data?.refreshToken) {
          clearSession(false);
          return false;
        }
        session.accessToken = body.data.accessToken;
        session.refreshToken = body.data.refreshToken;
        return true;
      })().finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  async function apiRequest(path, options = {}, retry = true) {
    const headers = new Headers(options.headers || {});
    if (session?.accessToken) headers.set("authorization", `Bearer ${session.accessToken}`);
    const result = await fetchJson(path, { ...options, headers });
    if (result.response.status === 401 && retry && session?.refreshToken && path !== `${API}/auth/refresh`) {
      if (await rotateSession()) return apiRequest(path, options, false);
      throw new Error("Your session has expired. Sign in again to view protected data.");
    }
    if (!result.response.ok) {
      const message = typeof result.body?.message === "string" ? result.body.message : "The request could not be completed.";
      throw new Error(message);
    }
    return result.body;
  }

  function updateAuthControls() {
    const label = $("#auth-button-label");
    const avatar = $("#avatar-mark");
    if (session?.user) {
      const name = typeof session.user.firstName === "string" ? session.user.firstName : "Workspace";
      label.textContent = `${name} · Sign out`;
      avatar.textContent = name.slice(0, 1).toUpperCase();
      $("#welcome-name").textContent = `${name}, your operation is in view.`;
      $("#hero-login").textContent = "Workspace connected ✓";
      $("#hero-login").disabled = true;
    } else {
      label.textContent = "Sign in";
      avatar.textContent = "↗";
      $("#welcome-name").textContent = "Let’s move things forward.";
      $("#hero-login").textContent = "Access workspace ↗";
      $("#hero-login").disabled = false;
    }
  }

  function setMetric(selector, value, label, state = "ready") {
    const valueNode = $(selector);
    valueNode.textContent = Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—";
    const statusNode = valueNode.closest(".metric-card")?.querySelector(".metric-tag");
    if (statusNode) {
      statusNode.textContent = label;
      statusNode.classList.toggle("state-ready", state === "ready");
      statusNode.classList.toggle("state-error", state === "error");
    }
  }

  function setProtectedEmpty(message = "Sign in for live totals") {
    setMetric("#driver-count", NaN, "Staff sign-in required", "locked");
    setMetric("#vehicle-count", NaN, "Staff sign-in required", "locked");
    setMetric("#transit-count", NaN, message, "locked");
    setMetric("#delivery-count", NaN, message, "locked");
    setText("#driver-status", "Staff sign-in required");
    setText("#vehicle-status", "Staff sign-in required");
    setText("#transit-status", message);
    setText("#delivery-status", message);
    setText("#drivers-copy", "Sign in with an authorized staff account to see the driver network overview.");
    setText("#vehicles-copy", "Sign in with an authorized staff account to see available fleet capacity.");
    setText("#drivers-meta", "Protected fleet data");
    setText("#vehicles-meta", "Protected fleet data");
    setText("#flow-total", "—");
    $("#flow-chart").innerHTML = '<div class="flow-empty">Sign in to load delivery flow from the API.</div>';
  }

  function renderDeliveryFlow(stats) {
    const rows = [
      ["Pending", Number(stats.pending) || 0, "pending"],
      ["Assigned", Number(stats.assigned) || 0, "assigned"],
      ["Picked up", Number(stats.pickedUp) || 0, "assigned"],
      ["In transit", Number(stats.inTransit) || 0, "transit"],
      ["Delivered", Number(stats.delivered) || 0, "delivered"],
      ["Cancelled", Number(stats.cancelled) || 0, "cancelled"],
    ];
    const maximum = Math.max(1, ...rows.map(([, count]) => count));
    $("#flow-total").textContent = new Intl.NumberFormat().format(Number(stats.total) || 0);
    if (!Number(stats.total)) {
      $("#flow-chart").innerHTML = '<div class="flow-empty">No deliveries recorded yet.</div>';
      return;
    }
    const chart = $("#flow-chart");
    chart.replaceChildren();
    for (const [label, count, kind] of rows) {
      const row = document.createElement("div");
      row.className = "flow-row";
      const name = document.createElement("span");
      name.className = "flow-label";
      name.textContent = label;
      const track = document.createElement("span");
      track.className = "flow-track";
      const bar = document.createElement("span");
      bar.className = `flow-bar ${kind}`;
      bar.style.width = `${Math.max(count > 0 ? 2 : 0, (count / maximum) * 100)}%`;
      track.append(bar);
      const number = document.createElement("span");
      number.className = "flow-count";
      number.textContent = new Intl.NumberFormat().format(count);
      row.append(name, track, number);
      chart.append(row);
    }
  }

  async function loadStaffOverview() {
    const results = await Promise.allSettled([
      apiRequest(`${API}/deliveries/statistics`),
      apiRequest(`${API}/drivers?status=ACTIVE&page=1&limit=1`),
      apiRequest(`${API}/vehicles?status=ACTIVE&page=1&limit=1`),
    ]);

    const [deliveryResult, driverResult, vehicleResult] = results;
    if (deliveryResult.status === "fulfilled") {
      const stats = deliveryResult.value?.data || {};
      setMetric("#transit-count", Number(stats.inTransit), "Current in-transit status");
      setMetric("#delivery-count", Number(stats.total), "Across all stages");
      renderDeliveryFlow(stats);
      setText("#delivery-status", "Live API totals");
      setText("#transit-status", "Live API totals");
      setText("#delivery-updated", "Updated from protected delivery statistics");
    } else {
      setMetric("#transit-count", NaN, "Could not load totals", "error");
      setMetric("#delivery-count", NaN, "Could not load totals", "error");
      $("#flow-chart").innerHTML = '<div class="flow-empty">Delivery totals are temporarily unavailable.</div>';
      setText("#flow-total", "—");
    }

    if (driverResult.status === "fulfilled") {
      const total = Number(driverResult.value?.pagination?.total);
      setMetric("#driver-count", total, "Active accounts");
      setText("#drivers-copy", total === 0 ? "No active driver accounts are currently recorded." : `${new Intl.NumberFormat().format(total)} active driver accounts are available in the protected directory.`);
      setText("#drivers-meta", "Active account count · API");
    } else {
      setMetric("#driver-count", NaN, "Could not load count", "error");
      setText("#drivers-copy", "The protected driver overview is temporarily unavailable.");
    }

    if (vehicleResult.status === "fulfilled") {
      const total = Number(vehicleResult.value?.pagination?.total);
      setMetric("#vehicle-count", total, "Active vehicles");
      setText("#vehicles-copy", total === 0 ? "No active vehicles are currently recorded." : `${new Intl.NumberFormat().format(total)} active vehicles are listed in the protected fleet directory.`);
      setText("#vehicles-meta", "Active vehicle count · API");
    } else {
      setMetric("#vehicle-count", NaN, "Could not load count", "error");
      setText("#vehicles-copy", "The protected vehicle overview is temporarily unavailable.");
    }
  }

  async function loadPersonalOverview() {
    const isDriver = session.user.role === "DRIVER";
    const path = isDriver ? `${API}/deliveries/assigned` : `${API}/deliveries/my`;
    try {
      const result = await apiRequest(path);
      const deliveries = Array.isArray(result?.data) ? result.data : [];
      const total = isDriver && Number.isFinite(result?.count) ? Number(result.count) : deliveries.length;
      const inTransit = deliveries.filter((delivery) => delivery.status === "IN_TRANSIT").length;
      setMetric("#delivery-count", total, "Your deliveries");
      setMetric("#transit-count", inTransit, "Your active deliveries");
      setText("#delivery-status", "Private account data");
      setText("#transit-status", "Private account data");
      setText("#driver-count", "—", "Staff role required", "locked");
      setText("#vehicle-count", "—", "Staff role required", "locked");
      setText("#drivers-copy", "Driver directory totals are available only to authorized staff.");
      setText("#vehicles-copy", "Fleet totals are available only to authorized staff.");
      setText("#drivers-meta", "Staff role required");
      setText("#vehicles-meta", "Staff role required");
      setText("#flow-total", new Intl.NumberFormat().format(total));
      if (total === 0) {
        $("#flow-chart").innerHTML = '<div class="flow-empty">No deliveries are associated with this account yet.</div>';
      } else {
        const ownStats = {
          total,
          pending: deliveries.filter((item) => item.status === "PENDING").length,
          assigned: deliveries.filter((item) => item.status === "ASSIGNED").length,
          pickedUp: deliveries.filter((item) => item.status === "PICKED_UP").length,
          inTransit: deliveries.filter((item) => item.status === "IN_TRANSIT").length,
          delivered: deliveries.filter((item) => item.status === "DELIVERED").length,
          cancelled: deliveries.filter((item) => item.status === "CANCELLED").length,
        };
        renderDeliveryFlow(ownStats);
      }
      setText("#delivery-updated", "Limited to your own account data");
    } catch {
      setMetric("#delivery-count", NaN, "Could not load your deliveries", "error");
      setMetric("#transit-count", NaN, "Could not load your deliveries", "error");
      $("#flow-chart").innerHTML = '<div class="flow-empty">Your delivery overview is temporarily unavailable.</div>';
      setText("#flow-total", "—");
    }
  }

  async function loadProtectedOverview() {
    if (!session) {
      setProtectedEmpty();
      return;
    }
    setText("#delivery-period", session.user.role === "CUSTOMER" || session.user.role === "DRIVER" ? "Your account" : "Current totals");
    if (STAFF_ROLES.has(session.user.role)) await loadStaffOverview();
    else if (["CUSTOMER", "DRIVER"].includes(session.user.role)) await loadPersonalOverview();
    else setProtectedEmpty("This role has no dashboard overview");
    setText("#last-updated", new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date()));
  }

  async function loadHealth() {
    const apiState = $("#api-state");
    const databaseState = $("#database-state");
    const redisState = $("#redis-state");
    const setDependency = (element, up) => {
      element.className = `dependency-state ${up ? "up" : "down"}`;
      element.innerHTML = `<i></i>${up ? "Operational" : "Unavailable"}`;
    };
    try {
      const [{ response: apiResponse, body: apiBody }, readiness] = await Promise.all([
        fetchJson(`${API}/health`),
        fetchJson(`${API}/health/ready`),
      ]);
      const apiUp = apiResponse.ok && apiBody?.data?.status === "healthy";
      const ready = readiness.response.ok && readiness.body?.data?.status === "ready";
      const deps = readiness.body?.data?.dependencies || {};
      apiState.className = `dependency-state ${apiUp ? "up" : "down"}`;
      apiState.innerHTML = `<i></i>${apiUp ? "Operational" : "Unavailable"}`;
      setDependency(databaseState, deps.database === true);
      setDependency(redisState, deps.redis === true);
      const headline = $("#health-headline");
      headline.textContent = ready ? "All systems operational" : apiUp ? "API is online" : "Health check unavailable";
      setText("#health-description", ready ? "API, database, and cache are responding." : apiUp ? "A required dependency needs attention." : "FleetFlow did not return a healthy response.");
      setText("#health-score", ready ? "UP" : apiUp ? "!" : "—");
      setText("#health-checked-at", `Checked ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date())} · refreshes every 30 sec`);
      $("#health-pill").className = `health-pill ${ready ? "up" : "down"}`;
      $("#health-pill span").textContent = ready ? "Healthy" : apiUp ? "Degraded" : "Unavailable";
      $("#health-ring").classList.toggle("ready", ready);
      $("#health-ring").classList.toggle("degraded", apiUp && !ready);
      $("#health-ring").classList.toggle("unavailable", !apiUp);
      $("#sidebar-health-orb").className = `health-orb ${ready ? "up" : "down"}`;
      setText("#sidebar-health-text", ready ? "All systems operational" : apiUp ? "Needs attention" : "API unavailable");
      setText("#footer-health", ready ? "API healthy" : "API needs attention");
    } catch {
      setDependency(apiState, false);
      setDependency(databaseState, false);
      setDependency(redisState, false);
      setText("#health-headline", "Health check unavailable");
      setText("#health-description", "The FleetFlow API could not be reached.");
      setText("#health-score", "—");
      $("#health-pill").className = "health-pill down";
      $("#health-pill span").textContent = "Unavailable";
      $("#health-ring").classList.add("unavailable");
      $("#sidebar-health-orb").className = "health-orb down";
      setText("#sidebar-health-text", "API unavailable");
      setText("#footer-health", "API unavailable");
      setText("#health-checked-at", "Could not reach the API · retrying in 30 sec");
    }
  }

  function clearSession(showMessage = true) {
    session = null;
    refreshInFlight = null;
    updateAuthControls();
    setProtectedEmpty();
    if (showMessage) showToast("You have signed out. Protected data has been cleared.");
  }

  function openLogin() {
    if (session) {
      void signOut();
      return;
    }
    const modal = $("#login-modal");
    modal.hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(() => $("#login-email").focus(), 30);
  }

  function closeLogin() {
    $("#login-modal").hidden = true;
    document.body.classList.remove("modal-open");
    $("#login-error").hidden = true;
  }

  async function signOut() {
    const refreshToken = session?.refreshToken;
    try {
      if (refreshToken) await fetchJson(`${API}/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } finally {
      clearSession();
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    const errorBox = $("#login-error");
    const submit = $("#login-submit");
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      const { response, body } = await fetchJson(`${API}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: $("#login-email").value.trim(),
          password: $("#login-password").value,
        }),
      });
      if (!response.ok || !body?.data?.tokens?.accessToken || !body?.data?.tokens?.refreshToken) {
        throw new Error(response.status === 401 ? "Email or password was not accepted." : (body?.message || "Could not sign in. Check your details and try again."));
      }
      session = {
        accessToken: body.data.tokens.accessToken,
        refreshToken: body.data.tokens.refreshToken,
        user: body.data.user,
      };
      closeLogin();
      updateAuthControls();
      await loadProtectedOverview();
      showToast("Signed in. Protected overview loaded from FleetFlow.");
      $("#login-password").value = "";
    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : "Could not sign in. Try again.";
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.innerHTML = 'Sign in securely <span>→</span>';
    }
  }

  function updateClock() {
    const now = new Date();
    setText("#local-clock", new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now));
    setText("#local-date", new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(now));
  }

  function init() {
    setProtectedEmpty();
    updateClock();
    void loadHealth();
    setInterval(updateClock, 30_000);
    setInterval(loadHealth, 30_000);
    setInterval(() => { if (session) void loadProtectedOverview(); }, 60_000);

    $("#open-login").addEventListener("click", openLogin);
    $("#hero-login").addEventListener("click", openLogin);
    $("#close-login").addEventListener("click", closeLogin);
    $("#login-modal").addEventListener("click", (event) => {
      if (event.target === $("#login-modal")) closeLogin();
    });
    $("#login-form").addEventListener("submit", submitLogin);
    $("#toggle-password").addEventListener("click", () => {
      const password = $("#login-password");
      const visible = password.type === "text";
      password.type = visible ? "password" : "text";
      $("#toggle-password").textContent = visible ? "Show" : "Hide";
      $("#toggle-password").setAttribute("aria-label", visible ? "Show password" : "Hide password");
    });
    $("#mobile-menu").addEventListener("click", () => {
      const open = $("#sidebar").classList.toggle("open");
      $("#mobile-menu").setAttribute("aria-expanded", String(open));
    });
    $("#sidebar").addEventListener("click", (event) => {
      if (event.target.closest(".nav-link")) {
        $("#sidebar").classList.remove("open");
        $("#mobile-menu").setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("#login-modal").hidden) closeLogin();
    });
    document.querySelectorAll("[data-requires-auth]").forEach((button) => button.addEventListener("click", () => {
      if (!session) openLogin();
      else window.open(`${API}/docs/`, "_blank", "noopener,noreferrer");
    }));
    updateAuthControls();
  }

  init();
})();
