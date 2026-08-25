import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { isQueueIdle, onQueueChange } from "./job-queue.js";
import { DeferredUpdateInstaller } from "./update-gate.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type UpdatePhase =
  | "disabled"
  | "checking"
  | "current"
  | "downloading"
  | "waiting"
  | "installing"
  | "failed";

export interface UpdateSnapshot {
  phase: UpdatePhase;
  message: string;
  version?: string;
  percent?: number;
}

export interface UpdaterController {
  getState: () => UpdateSnapshot;
  reconsiderInstall: () => void;
  dispose: () => void;
}

interface UpdaterOptions {
  restartBlocked: () => boolean;
  prepareToInstall: () => void;
  sendStatus: (snapshot: UpdateSnapshot) => void;
}

export function initializeUpdater(options: UpdaterOptions): UpdaterController {
  let state: UpdateSnapshot = app.isPackaged
    ? { phase: "checking", message: "Checking for Librarian updates…" }
    : { phase: "disabled", message: "Automatic updates are disabled in development." };
  let checkTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  const publish = (next: UpdateSnapshot): void => {
    state = next;
    options.sendStatus(state);
  };

  if (!app.isPackaged) {
    return {
      getState: () => state,
      reconsiderInstall: () => undefined,
      dispose: () => undefined,
    };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  const gate = new DeferredUpdateInstaller({
    canInstallNow: () => isQueueIdle() && !options.restartBlocked(),
    prepareToInstall: options.prepareToInstall,
    install: () => {
      autoUpdater.quitAndInstall(false, true);
    },
    onStateChange: ({ pending, installing }) => {
      if (installing) {
        publish({
          phase: "installing",
          message: "Installing update and reopening Librarian…",
          version: state.version,
        });
      } else if (pending) {
        publish({
          phase: "waiting",
          message: "Update ready — waiting for jobs and sign-in windows to finish.",
          version: state.version,
        });
      }
    },
  });

  const reconsiderInstall = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      gate.evaluate();
    }, 0);
    retryTimer.unref();
  };

  const unsubscribeQueue = onQueueChange(reconsiderInstall);

  autoUpdater.on("checking-for-update", () => {
    publish({ phase: "checking", message: "Checking for Librarian updates…" });
  });
  autoUpdater.on("update-not-available", (info) => {
    publish({
      phase: "current",
      message: "Librarian is up to date.",
      version: info.version,
    });
  });
  autoUpdater.on("update-available", (info) => {
    publish({
      phase: "downloading",
      message: `Downloading Librarian ${info.version}…`,
      version: info.version,
      percent: 0,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    publish({
      phase: "downloading",
      message: `Downloading Librarian ${state.version ?? "update"}…`,
      version: state.version,
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publish({
      phase: "waiting",
      message: "Update ready — checking whether Librarian is idle.",
      version: info.version,
      percent: 100,
    });
    gate.requestInstall();
  });
  autoUpdater.on("error", (error) => {
    publish({
      phase: "failed",
      message: `Update check failed: ${error.message}`,
      version: state.version,
    });
  });

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      publish({ phase: "failed", message: `Update check failed: ${message}` });
    });
  };

  check();
  checkTimer = setInterval(check, CHECK_INTERVAL_MS);
  checkTimer.unref();

  return {
    getState: () => state,
    reconsiderInstall,
    dispose: () => {
      if (checkTimer) clearInterval(checkTimer);
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeQueue();
    },
  };
}
