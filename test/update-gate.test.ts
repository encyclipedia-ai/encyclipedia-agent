import assert from "node:assert/strict";
import test from "node:test";
import { DeferredUpdateInstaller } from "../src/update-gate.js";

test("a downloaded update waits until work becomes idle", () => {
  let idle = false;
  let prepared = 0;
  let installed = 0;
  const gate = new DeferredUpdateInstaller({
    canInstallNow: () => idle,
    prepareToInstall: () => {
      prepared += 1;
    },
    install: () => {
      installed += 1;
    },
  });

  assert.equal(gate.requestInstall(), false);
  assert.deepEqual(gate.state, { pending: true, installing: false });
  assert.equal(installed, 0);

  idle = true;
  assert.equal(gate.evaluate(), true);
  assert.equal(prepared, 1);
  assert.equal(installed, 1);
});

test("new work arriving during preparation defers installation again", () => {
  let idle = true;
  let installed = 0;
  const gate = new DeferredUpdateInstaller({
    canInstallNow: () => idle,
    prepareToInstall: () => {
      idle = false;
    },
    install: () => {
      installed += 1;
    },
  });

  assert.equal(gate.requestInstall(), false);
  assert.deepEqual(gate.state, { pending: true, installing: false });
  assert.equal(installed, 0);

  idle = true;
  assert.equal(gate.evaluate(), false);
  assert.equal(installed, 0);
});

test("blocking UI such as OAuth prevents installation", () => {
  let oauthOpen = true;
  let installed = 0;
  const gate = new DeferredUpdateInstaller({
    canInstallNow: () => !oauthOpen,
    prepareToInstall: () => undefined,
    install: () => {
      installed += 1;
    },
  });

  gate.requestInstall();
  assert.equal(installed, 0);
  oauthOpen = false;
  assert.equal(gate.evaluate(), true);
  assert.equal(installed, 1);
});
