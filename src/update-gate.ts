export interface DeferredInstallState {
  pending: boolean;
  installing: boolean;
}

export interface DeferredInstallOptions {
  canInstallNow: () => boolean;
  prepareToInstall: () => void;
  install: () => void;
  onStateChange?: (state: DeferredInstallState) => void;
}

/**
 * Holds a downloaded update until work and blocking UI are both idle.
 * The safety condition is checked again after claim/heartbeat work is stopped.
 */
export class DeferredUpdateInstaller {
  #pending = false;
  #installing = false;

  constructor(private readonly options: DeferredInstallOptions) {}

  get state(): DeferredInstallState {
    return { pending: this.#pending, installing: this.#installing };
  }

  requestInstall(): boolean {
    this.#pending = true;
    this.#emit();
    return this.evaluate();
  }

  evaluate(): boolean {
    if (!this.#pending || this.#installing || !this.options.canInstallNow()) {
      return false;
    }

    this.options.prepareToInstall();
    if (!this.options.canInstallNow()) {
      this.#emit();
      return false;
    }

    this.#pending = false;
    this.#installing = true;
    this.#emit();
    this.options.install();
    return true;
  }

  #emit(): void {
    this.options.onStateChange?.(this.state);
  }
}
