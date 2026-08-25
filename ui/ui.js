const $ = (id) => document.getElementById(id);

const loginEl = $("login");
const clipperEl = $("clipper");
const dot = $("dot");
const statusLabel = $("status-label");
const statusMessage = $("status-message");
const statusEmail = $("status-email");
const loginForm = $("login-form");
const clipForm = $("clip-form");
const signInBtn = $("sign-in");
const googleBtn = $("google-sign-in");
const signOutBtn = $("sign-out");
const clipBtn = $("clip");
const passwordInput = $("password");
const togglePassword = $("toggle-password");
const queueEl = $("queue");
const queueEmpty = $("queue-empty");
const queueSummary = $("queue-summary");
const updateCard = $("update-card");
const updateDot = $("update-dot");
const updateLabel = $("update-label");
const updateMessage = $("update-message");

const PHASE_LABEL = {
  queued: "In line",
  lookup: "Looking up",
  download: "Downloading",
  analyze: "Scanning",
  upload: "Uploading",
  render: "Rendering",
  done: "Shelved",
  error: "Could not shelve",
};

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("v");
    if (id) return `youtube.com/watch?v=${id}`;
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function renderQueue(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  const active = list.filter((item) =>
    ["lookup", "download", "analyze", "upload"].includes(item.phase),
  ).length;
  const waiting = list.filter((item) => item.phase === "queued").length;
  const rendering = list.filter((item) => item.phase === "render").length;
  queueSummary.textContent = [
    `${active} active`,
    waiting ? `${waiting} waiting` : null,
    rendering ? `${rendering} rendering` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const rank = {
    lookup: 0,
    download: 1,
    analyze: 2,
    upload: 3,
    queued: 4,
    render: 5,
    error: 6,
    done: 7,
  };
  list.sort((a, b) => (rank[a.phase] ?? 9) - (rank[b.phase] ?? 9) || a.addedAt - b.addedAt);
  const waitingIds = list
    .filter((item) => item.phase === "queued")
    .map((item) => item.id);
  queueEl.replaceChildren();
  queueEmpty.classList.toggle("hidden", list.length > 0);
  for (const item of list) {
    const li = document.createElement("li");
    li.className = `queue-item phase-${item.phase}`;
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = item.title || shortUrl(item.url);
    const meta = document.createElement("div");
    meta.className = "queue-meta";
    const phase = document.createElement("span");
    phase.className = "queue-phase";
    phase.textContent = PHASE_LABEL[item.phase] ?? item.phase;
    meta.append(phase);
    if (item.source === "remote") {
      const src = document.createElement("span");
      src.className = "queue-source";
      const recut =
        item.kind === "recut" ||
        (Number.isFinite(Number(item.startSec)) &&
          Number.isFinite(Number(item.durationSec)) &&
          Number(item.durationSec) > 0);
      src.textContent = recut ? "Clip edit" : "From the web";
      meta.append(src);
    }
    const detail = document.createElement("p");
    detail.className = "queue-detail";
    const position = waitingIds.indexOf(item.id);
    detail.textContent =
      item.phase === "queued" && position >= 0
        ? `Waiting · ${position + 1} of ${waitingIds.length} in line`
        : item.detail || "";
    li.append(title, meta, detail);
    if (item.percent != null && (item.phase === "download" || item.phase === "upload")) {
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(item.percent)));
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(0, Math.min(100, item.percent))}%`;
      bar.append(fill);
      li.append(bar);
    }
    queueEl.append(li);
  }
}

function apply(snap) {
  const signedIn = snap.status !== "signed_out";
  loginEl.classList.toggle("hidden", signedIn);
  clipperEl.classList.toggle("hidden", !signedIn);

  const labels = {
    signed_out: "Away from the stacks",
    starting: "Opening the stacks",
    running: "On duty",
    working: "At work",
    error: "Needs attention",
  };
  statusLabel.textContent = labels[snap.status] ?? snap.status;
  statusMessage.textContent = snap.message || "";
  statusEmail.textContent = snap.email ? `Signed in as ${snap.email}` : "";

  dot.className =
    "dot " +
    (snap.status === "running"
      ? "on"
      : snap.status === "working" || snap.status === "starting"
        ? "work"
        : snap.status === "error"
          ? "bad"
          : "off");

  const busy = Boolean(snap.busy);
  signInBtn.disabled = busy;
  googleBtn.disabled = busy;
  clipBtn.disabled = !signedIn;
  renderQueue(snap.queue);
}

function applyUpdate(snap) {
  if (!snap || snap.phase === "disabled") {
    updateCard.classList.add("hidden");
    return;
  }

  updateCard.classList.remove("hidden");
  const labels = {
    checking: "Checking for updates",
    current: "Up to date",
    downloading: `Downloading update${Number.isFinite(snap.percent) ? ` · ${snap.percent}%` : ""}`,
    waiting: "Update ready",
    installing: "Installing update",
    failed: "Update unavailable",
  };
  updateLabel.textContent = labels[snap.phase] ?? "Librarian update";
  updateMessage.textContent = snap.message || "";
  updateDot.className = `update-dot update-${snap.phase}`;
}

togglePassword.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  togglePassword.textContent = show ? "Hide" : "Show";
  togglePassword.setAttribute("aria-pressed", show ? "true" : "false");
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = passwordInput.value;
  if (!email || !password) return;
  signInBtn.disabled = true;
  googleBtn.disabled = true;
  try {
    await window.helper.signIn(email, password);
    passwordInput.value = "";
  } catch (err) {
    statusMessage.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    signInBtn.disabled = false;
    googleBtn.disabled = false;
  }
});

googleBtn.addEventListener("click", async () => {
  signInBtn.disabled = true;
  googleBtn.disabled = true;
  try {
    await window.helper.signInGoogle();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== "Google sign-in was cancelled.") {
      statusMessage.textContent = message;
    }
  } finally {
    signInBtn.disabled = false;
    googleBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => {
  void window.helper.signOut();
});

clipForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = $("url").value.trim();
  if (!url) return;
  const length = document.querySelector('input[name="length"]:checked')?.value ?? "short";
  clipBtn.disabled = true;
  try {
    await window.helper.clip(url, length);
    $("url").value = "";
    $("url").focus();
  } catch (err) {
    statusMessage.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    clipBtn.disabled = false;
  }
});

window.helper.onState(apply);
void window.helper.getState().then(apply);
window.helper.onUpdateState(applyUpdate);
void window.helper.getUpdateState().then(applyUpdate);
