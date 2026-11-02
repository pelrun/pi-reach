import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "publish-npm.sh");
const TOKEN = "github-packages-token-must-not-leak";

// Fake npm/pnpm: record every call and simulate a registry where 9.9.9 is not published yet.
const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = process.env.FAKE_STATE_DIR;
const userconfig = process.env.NPM_CONFIG_USERCONFIG;
fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify({
  name,
  args,
  npmrc: userconfig && fs.existsSync(userconfig) ? fs.readFileSync(userconfig, "utf8") : null,
}) + "\n");
const publishedMarker = path.join(state, "published");

if (name === "pnpm" && args[0] === "verify") process.exit(0);
if (name === "pnpm" && args[0] === "pack") {
  const filename = path.join(args[args.indexOf("--pack-destination") + 1], "pelrun-pi-reach-9.9.9.tgz");
  fs.writeFileSync(filename, "fake tarball");
  process.stdout.write(JSON.stringify({ filename, files: [{ path: "dist/index.js" }] }) + "\n");
  process.exit(0);
}
if (name === "npm" && args[0] === "whoami") process.exit(process.env.FAKE_NPM_LOGGED_IN === "1" ? 0 : 1);
if (name === "npm" && args[0] === "view") {
  if (process.env.FAKE_ALREADY_PUBLISHED === "1" || fs.existsSync(publishedMarker)) {
    process.stdout.write("9.9.9\n");
    process.exit(0);
  }
  process.stderr.write("npm error code E404\n");
  process.exit(1);
}
if (name === "npm" && args[0] === "publish") {
  fs.writeFileSync(publishedMarker, "");
  process.exit(0);
}
process.stderr.write("unhandled fake command: " + name + " " + args.join(" ") + "\n");
process.exit(90);
`;

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-reach-publish-test-"));
  const fakeBin = join(root, "fake-bin");
  const tmp = join(root, "tmp");
  mkdirSync(fakeBin);
  mkdirSync(tmp);
  copyFileSync(SCRIPT, join(root, "publish-npm.sh"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@pelrun/pi-reach", version: "9.9.9" }));
  writeFileSync(join(root, "calls.jsonl"), "");
  for (const command of ["npm", "pnpm"]) {
    writeFileSync(join(fakeBin, command), FAKE_CLI);
    chmodSync(join(fakeBin, command), 0o755);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, fakeBin, tmp };
}

function run(fixture, args = [], extraEnv = {}) {
  const env = { ...process.env };
  // The real shell or CI job may carry credentials; each test sets its own authentication.
  for (const key of ["NODE_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_CONFIG_USERCONFIG", "npm_config_userconfig"]) delete env[key];
  return spawnSync("/bin/bash", [join(fixture.root, "publish-npm.sh"), ...args], {
    encoding: "utf8",
    input: "",
    env: { ...env, PATH: `${fixture.fakeBin}:${process.env.PATH}`, TMPDIR: fixture.tmp, FAKE_STATE_DIR: fixture.root, ...extraEnv },
  });
}

function calls(fixture) {
  return readFileSync(join(fixture.root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function commandLines(fixture) {
  return calls(fixture).map((call) => [call.name, ...call.args].join(" "));
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test("publishes the inspected tarball with NODE_AUTH_TOKEN through a temporary npmrc and confirms the version", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, [], { NODE_AUTH_TOKEN: TOKEN });
  assertSucceeded(result);
  const lines = commandLines(fixture);
  const packDir = lines[2]?.split(" --pack-destination ")[1];
  assert.ok(packDir?.startsWith(join(fixture.tmp, "pi-reach-pack.")), lines.join("\n"));
  assert.deepEqual(lines, [
    "npm view @pelrun/pi-reach@9.9.9 version --registry=https://npm.pkg.github.com",
    "pnpm verify",
    `pnpm pack --json --pack-destination ${packDir}`,
    `npm publish ${join(packDir, "pelrun-pi-reach-9.9.9.tgz")} --access public --ignore-scripts`,
    "npm view @pelrun/pi-reach@9.9.9 version --registry=https://npm.pkg.github.com --prefer-online",
  ]);
  const npmrc = calls(fixture).at(-1).npmrc;
  assert.match(npmrc, /^@pelrun:registry=https:\/\/npm\.pkg\.github\.com$/m);
  assert.match(npmrc, /^\/\/npm\.pkg\.github\.com\/:_authToken=\$\{NODE_AUTH_TOKEN\}$/m);
  for (const call of calls(fixture)) {
    assert.ok(!JSON.stringify(call).includes(TOKEN), "the token never reaches arguments or the npmrc file");
  }
  assert.match(result.stdout, /Publish succeeded: @pelrun\/pi-reach@9\.9\.9/);
  assert.deepEqual(readdirSync(fixture.tmp), [], "the temporary npmrc and pack directory are removed");
});

test("accepts GH_TOKEN and GITHUB_TOKEN as token sources", (t) => {
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const fixture = makeFixture(t);
    const result = run(fixture, [], { [key]: TOKEN });
    assertSucceeded(result);
    assert.ok(commandLines(fixture).some((line) => line.startsWith("npm publish")), key);
    for (const call of calls(fixture)) {
      assert.ok(!JSON.stringify(call).includes(TOKEN), "the token never reaches arguments or the npmrc file");
    }
  }
});

test("requires an authenticated npm session without a token", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not authenticated to https:\/\/npm\.pkg\.github\.com/);
  assert.deepEqual(commandLines(fixture), ["npm whoami --registry=https://npm.pkg.github.com"]);
});

test("refuses to upload a version that already exists on GitHub Packages", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, [], { NODE_AUTH_TOKEN: TOKEN, FAKE_ALREADY_PUBLISHED: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@pelrun\/pi-reach@9\.9\.9 already exists/);
  assert.ok(commandLines(fixture).every((line) => line.startsWith("npm view") || line.startsWith("npm whoami")));
});

test("rejects unknown arguments before touching npm", (t) => {
  for (const arg of ["--dry-run", "--stage"]) {
    const fixture = makeFixture(t);
    const result = run(fixture, [arg]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`unknown argument: ${arg}`));
    assert.deepEqual(commandLines(fixture), []);
  }
});
