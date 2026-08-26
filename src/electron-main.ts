import { app, BrowserWindow, ipcMain, nativeImage, session } from "electron";
import path from "node:path";
import {
  createGoogleAuthSession,
  isOAuthReturnUrl,
  oauthReturnError,
} from "./auth.js";
import { loadConfig } from "./config.js";
import {
  completeGoogleSignIn,
  queueClip,
  restoreSession,
  signIn,
  signOut,
  startHelperLoop,
  type HelperSnapshot,
} from "./runtime.js";
import {
  initializeUpdater,
  type UpdaterController,
} from "./updater.js";

const here = __dirname;
const ui = (...parts: string[]) => path.join(here, "..", "ui", ...parts);
const brandAsset = (...parts: string[]) =>
  path.join(here, "..", "build", ...parts);

app.setName("Encyclipedia Librarian");

let win: BrowserWindow | null = null;
let stopLoop: (() => void) | null = null;
let last: HelperSnapshot = {
  status: "starting",
  email: null,
  message: "Opening the stacks…",
  busy: false,
  queue: [],
};
let googleSignInOpen = false;
let signInInProgress = false;
let updater: UpdaterController | null = null;

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function emit(snap: Omit<HelperSnapshot, "queue"> & { queue?: HelperSnapshot["queue"] }): void {
  last = { ...snap, queue: snap.queue ?? last.queue };
  send("helper:state", last);
}

function beginLoop(): void {
  stopLoop?.();
  stopLoop = startHelperLoop(emit);
}

function chromeUserAgent(raw: string): string {
  return raw.replace(/\sElectron\/\S+/i, "");
}

function captureOAuthRedirect(
  authUri: string,
  continueUri: string,
): Promise<string> {
  const ses = session.fromPartition("persist:encyclipedia-google");

  return new Promise((resolve, reject) => {
    const oauthWin = new BrowserWindow({
      width: 520,
      height: 740,
      parent: win ?? undefined,
      modal: Boolean(win),
      title: "Sign in with Google",
      backgroundColor: "#f1ead8",
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    oauthWin.webContents.setUserAgent(
      chromeUserAgent(oauthWin.webContents.getUserAgent()),
    );

    let settled = false;
    const finish = (err: Error | null, redirectUrl?: string) => {
      if (settled) return;
      settled = true;
      ses.webRequest.onBeforeRequest(null);
      if (!oauthWin.isDestroyed()) oauthWin.close();
      if (err) reject(err);
      else resolve(redirectUrl!);
    };

    const tryCapture = (navUrl: string, event?: { preventDefault: () => void }) => {
      if (!isOAuthReturnUrl(navUrl, continueUri)) return false;
      event?.preventDefault();
      const denied = oauthReturnError(navUrl);
      if (denied) finish(new Error(denied));
      else finish(null, navUrl);
      return true;
    };

    ses.webRequest.onBeforeRequest(
      {
        urls: [
          "https://production-496405.firebaseapp.com/__/auth/handler*",
        ],
      },
      (details, callback) => {
        if (tryCapture(details.url)) {
          callback({ cancel: true });
          return;
        }
        callback({});
      },
    );

    oauthWin.webContents.on("will-redirect", (event, url) => {
      tryCapture(url, event);
    });
    oauthWin.webContents.on("will-navigate", (event, url) => {
      tryCapture(url, event);
    });
    oauthWin.webContents.on("will-frame-navigate", (event) => {
      tryCapture(event.url, event);
    });
    oauthWin.webContents.on("did-navigate", (_event, url) => {
      tryCapture(url);
    });
    oauthWin.webContents.on("did-navigate-in-page", (_event, url) => {
      tryCapture(url);
    });
    oauthWin.webContents.on(
      "did-fail-load",
      (_event, _code, _desc, validatedURL) => {
        tryCapture(validatedURL);
      },
    );

    oauthWin.on("closed", () => {
      finish(new Error("Google sign-in was cancelled."));
    });

    void oauthWin.loadURL(authUri);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 500,
    height: 820,
    minWidth: 420,
    minHeight: 640,
    title: "Encyclipedia Librarian",
    icon: brandAsset("icon.png"),
    backgroundColor: "#f1ead8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: ui("preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(ui("index.html"));
  win.on("closed", () => {
    win = null;
  });
}

ipcMain.handle("helper:get-state", () => last);
ipcMain.handle("helper:get-update-state", () => updater?.getState() ?? null);

ipcMain.handle(
  "helper:sign-in",
  async (_evt, body: { email?: string; password?: string }) => {
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";
    if (!email || !password) throw new Error("Email and password are required.");
    signInInProgress = true;
    emit({
      status: "starting",
      email,
      message: "Consulting the catalogue…",
      busy: true,
      queue: last.queue,
    });
    try {
      const cfg = await signIn(email, password);
      emit({
        status: "starting",
        email: cfg.email ?? email,
        message: "Taking up the post…",
        busy: true,
        queue: last.queue,
      });
      beginLoop();
      return { ok: true, email: cfg.email ?? email };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        status: "signed_out",
        email: null,
        message,
        busy: false,
        queue: [],
      });
      throw new Error(message);
    } finally {
      signInInProgress = false;
      updater?.reconsiderInstall();
    }
  },
);

ipcMain.handle("helper:sign-in-google", async () => {
  if (googleSignInOpen) throw new Error("Google sign-in is already open.");
  googleSignInOpen = true;
  emit({
    status: "starting",
    email: last.email,
    message: "Opening Google…",
    busy: true,
  });
  try {
    const started = await createGoogleAuthSession(loadConfig());
    const requestUri = await captureOAuthRedirect(
      started.authUri,
      started.continueUri,
    );
    emit({
      status: "starting",
      email: last.email,
      message: "Consulting the catalogue…",
      busy: true,
    });
    const cfg = await completeGoogleSignIn(requestUri, started.sessionId);
    emit({
      status: "starting",
      email: cfg.email ?? null,
      message: "Taking up the post…",
      busy: true,
    });
    beginLoop();
    return { ok: true, email: cfg.email ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      status: "signed_out",
      email: null,
      message:
        message === "Google sign-in was cancelled."
          ? "Sign in to consult the librarian."
          : message,
      busy: false,
    });
    throw new Error(message);
  } finally {
    googleSignInOpen = false;
    updater?.reconsiderInstall();
  }
});

ipcMain.handle("helper:sign-out", () => {
  stopLoop?.();
  stopLoop = null;
  signOut();
  emit({
    status: "signed_out",
    email: null,
    message: "You have left the library.",
    busy: false,
  });
});

ipcMain.handle(
  "helper:clip",
  async (_evt, body: { url?: string; clipLength?: "short" | "medium" }) => {
    const url = body.url?.trim() ?? "";
    if (!url) throw new Error("Paste a YouTube URL first.");
    const item = queueClip(url, body.clipLength === "medium" ? "medium" : "short");
    return { ok: true, id: item.id };
  },
);

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock?.setIcon(nativeImage.createFromPath(brandAsset("icon.png")));
  }
  createWindow();
  const sessionCfg = await restoreSession();
  if (sessionCfg) beginLoop();
  else {
    emit({
      status: "signed_out",
      email: null,
      message: "Sign in to consult the librarian.",
      busy: false,
    });
  }
  updater = initializeUpdater({
    restartBlocked: () => googleSignInOpen || signInInProgress,
    prepareToInstall: () => {
      stopLoop?.();
      stopLoop = null;
    },
    sendStatus: (snapshot) => send("helper:update-state", snapshot),
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopLoop?.();
  app.quit();
});

app.on("before-quit", () => {
  updater?.dispose();
  stopLoop?.();
});
