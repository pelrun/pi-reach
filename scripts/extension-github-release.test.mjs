import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'extension-github-release.sh');
const REPOSITORY = 'example/pi-reach';
const TOKEN = 'fake-gpr-token-must-not-leak';

// curl and gh doubles: record calls (curl logs only the URL, never the Authorization header with
// the token); curl returns a GitHub Packages packument (version set built from FAKE_PUBLISHED) with
// the FAKE_STATUS HTTP status code, or per-call codes from FAKE_STATUS_SEQ (e.g. "200 503").
const FAKE_CURL = `#!/usr/bin/env bash
url="\${@: -1}"
printf 'curl %s\\n' "$url" >> "$FAKE_LOG"
status="$FAKE_STATUS"
if [ -n "$FAKE_STATUS_SEQ" ]; then
  count_file="$(dirname "$FAKE_LOG")/curl-count"
  n="$(cat "$count_file" 2>/dev/null || echo 0)"
  printf '%s\\n' "$((n + 1))" > "$count_file"
  seq=($FAKE_STATUS_SEQ)
  status="\${seq[$((n % \${#seq[@]}))]}"
fi
versions=""
for v in $FAKE_PUBLISHED; do versions="$versions\\"$v\\":{},"; done
printf '{"versions":{%s}}\\n%s' "\${versions%,}" "$status"
`;
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const entry = { args };
const notesIndex = args.indexOf('--notes-file');
if (notesIndex >= 0) entry.notes = fs.readFileSync(args[notesIndex + 1], 'utf8');
fs.appendFileSync(process.env.FAKE_LOG, 'gh ' + JSON.stringify(entry) + '\n');
if (args[0] === 'release' && args[1] === 'view') process.exit(process.env.FAKE_RELEASE_EXISTS ? 0 : 1);
if (args[0] === 'api' && args[1].endsWith('/git/tags')) process.stdout.write('fake-tag-sha\n');
`;
// Minimal jq stand-in for the invocation shapes the script uses: `-r .version [file]` and
// `-e --arg v <value> '.versions | has($v)'`.
const FAKE_JQ = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--arg')) {
  const value = args[args.indexOf('--arg') + 2];
  const versions = JSON.parse(fs.readFileSync(0, 'utf8')).versions || {};
  const has = Object.prototype.hasOwnProperty.call(versions, value);
  process.stdout.write(has ? 'true\n' : 'false\n');
  process.exit(has ? 0 : 1);
}
const fileArg = args.find((arg, index) => index > 0 && !arg.startsWith('-') && arg !== '.version');
const data = JSON.parse(fileArg ? fs.readFileSync(fileArg, 'utf8') : fs.readFileSync(0, 'utf8'));
process.stdout.write(String(data.version) + '\n');
`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function commit(cwd, message, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

const manifest = (version, description = 'Pi Reach') => JSON.stringify({ name: '@pelrun/pi-reach', version, description });

// 0.0.1 and 0.0.2 were tagged at publish time; the current version is 0.0.3, with unpublished commits after it.
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-reach-extension-release-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  writeFileSync(join(bin, 'jq'), FAKE_JQ);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'jq'), 0o755);

  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'chore(release): 发布 Extension 0.0.1', { 'pi-extension/package.json': manifest('0.0.1') });
  git(repo, 'tag', '-a', 'extension-v0.0.1', '-m', 'Extension 0.0.1');
  commit(repo, 'fix: 修复扩展重连', { 'pi-extension/src/index.ts': 'export {};\n' });
  commit(repo, 'fix(pwa): 与扩展无关', { 'pwa/src/app.ts': 'export {};\n' });
  commit(repo, 'feat(protocol): 新增事件', { 'packages/protocol/src/index.ts': 'export {};\n' });
  const v2 = commit(repo, 'chore(release): 发布 PWA 0.0.9 与 Extension 0.0.2', {
    'pi-extension/package.json': manifest('0.0.2'),
  });
  git(repo, 'tag', '-a', 'extension-v0.0.2', '-m', 'Extension 0.0.2');
  commit(repo, 'docs: 更新扩展描述', { 'pi-extension/package.json': manifest('0.0.2', 'Pi Reach extension') });
  const v3 = commit(repo, 'chore(release): 发布 Extension 0.0.3', {
    'pi-extension/package.json': manifest('0.0.3', 'Pi Reach extension'),
  });
  commit(repo, 'fix: 下一版本的修复', { 'pi-extension/src/index.ts': 'export const next = 1;\n' });
  return { root, repo, v2, v3 };
}

function run(fixture, args, { status = '200', statusSeq = '', published = '0.0.1 0.0.2 0.0.3', token = TOKEN, releaseExists = false } = {}) {
  const log = join(fixture.root, 'calls.log');
  const summary = join(fixture.root, 'summary.md');
  rmSync(log, { force: true });
  rmSync(join(fixture.root, 'curl-count'), { force: true });
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: fixture.repo,
    encoding: 'utf8',
    env: {
      ...gitEnv(),
      PATH: `${join(fixture.root, 'bin')}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_STATUS: status,
      FAKE_STATUS_SEQ: statusSeq,
      FAKE_PUBLISHED: published,
      FAKE_RELEASE_EXISTS: releaseExists ? '1' : '',
      GH_TOKEN: token,
      GITHUB_TOKEN: '',
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: fixture.root,
      RUN_URL: 'https://github.com/example/pi-reach/actions/runs/123',
    },
  });
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const curl = lines.filter((line) => line.startsWith('curl '));
  const gh = lines.filter((line) => line.startsWith('gh ')).map((line) => JSON.parse(line.slice(3)));
  return { result, curl, gh };
}

function withFixture(fn) {
  const fixture = createFixture();
  try {
    fn(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

const tagV3 = (fixture) => git(fixture.repo, 'tag', '-a', 'extension-v0.0.3', '-m', 'Extension 0.0.3', fixture.v3);

test('tag: creates an annotated tag on the commit that was just published', () => withFixture((fixture) => {
  const { result, curl, gh } = run(fixture, ['tag', '0.0.3', fixture.v3]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curl.length, 0);
  assert.deepEqual(gh.map((call) => call.args), [
    ['api', `repos/${REPOSITORY}/git/tags`, '-f', 'tag=extension-v0.0.3', '-f', 'message=Extension 0.0.3',
      '-f', `object=${fixture.v3}`, '-f', 'type=commit', '--jq', '.sha'],
    ['api', `repos/${REPOSITORY}/git/refs`, '-f', 'ref=refs/tags/extension-v0.0.3', '-f', 'sha=fake-tag-sha'],
  ]);
  assert.ok(readFileSync(join(fixture.root, 'summary.md'), 'utf8').includes('extension-v0.0.3'));
}));

test('tag: skips on re-run when the tag points to the same commit, fails when it points elsewhere', () => withFixture((fixture) => {
  const same = run(fixture, ['tag', '0.0.2', fixture.v2]);
  assert.equal(same.result.status, 0, same.result.stderr);
  assert.equal(same.gh.length, 0);

  git(fixture.repo, 'tag', '-f', '-a', 'extension-v0.0.2', '-m', 'Extension 0.0.2', 'HEAD~1');
  const other = run(fixture, ['tag', '0.0.2', fixture.v2]);
  assert.notEqual(other.result.status, 0);
  assert.match(other.result.stderr, /already points to a different commit/);
  assert.equal(other.gh.length, 0);
}));

test('tag: rejects a version mismatching the commit, an invalid version, or an abbreviated SHA', () => withFixture((fixture) => {
  const mismatch = run(fixture, ['tag', '0.0.3', fixture.v2]);
  assert.notEqual(mismatch.result.status, 0);
  assert.match(mismatch.result.stderr, /version 0\.0\.2, not 0\.0\.3/);

  const invalid = run(fixture, ['tag', '0.0.3;touch x', fixture.v3]);
  assert.match(invalid.result.stderr, /Invalid version format/);

  const short = run(fixture, ['tag', '0.0.3', fixture.v3.slice(0, 7)]);
  assert.match(short.result.stderr, /full 40-character SHA/);
  assert.equal(mismatch.gh.length + invalid.gh.length + short.gh.length, 0);
}));

test('release: creates the Latest Release from the existing tag once the current version is published, without creating a tag', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, curl, gh } = run(fixture, ['release']);
  assert.equal(result.status, 0, result.stderr);
  // First confirm the current version is published, then confirm the baseline tag 0.0.2 is published.
  assert.equal(curl.length, 2);
  for (const line of curl) {
    assert.ok(line.includes('https://npm.pkg.github.com/@pelrun%2Fpi-reach'), line);
    assert.ok(!line.includes(TOKEN), 'curl calls are logged without the Authorization header');
  }
  assert.deepEqual(gh.map((call) => call.args.slice(0, 2)), [['release', 'view'], ['release', 'create']]);
  const release = gh[1];
  assert.deepEqual(release.args.filter((arg) => !arg.endsWith('.md')), [
    'release', 'create', 'extension-v0.0.3', '--repo', REPOSITORY, '--verify-tag', '--title', 'Extension 0.0.3',
    '--notes-file', '--latest',
  ]);
  // The previous tag is 0.0.2: list commits touching the extension or protocol since it, excluding
  // release commits and commits after the version bump.
  assert.equal(release.notes, [
    'GitHub Packages: [`@pelrun/pi-reach@0.0.3`](https://github.com/pelrun/pi-reach/packages)',
    '',
    'Workflow run: [view run](https://github.com/example/pi-reach/actions/runs/123)',
    '',
    '## Changes',
    '',
    '- docs: 更新扩展描述',
    '',
  ].join('\n'));
}));

test('release: backfilled historical versions are not marked Latest and the input is trimmed', () => withFixture((fixture) => {
  const { result, gh } = run(fixture, ['release', ' 0.0.2 ']);
  assert.equal(result.status, 0, result.stderr);
  const release = gh.at(-1);
  assert.equal(release.args[2], 'extension-v0.0.2');
  assert.ok(release.args.includes('--latest=false'));
  // Commits unrelated to the extension do not enter the notes.
  assert.ok(release.notes.endsWith('## Changes\n\n- feat(protocol): 新增事件\n- fix: 修复扩展重连\n'));
}));

test('release: skips tags whose version is unpublished and lists changes from the previous published version', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, curl, gh } = run(fixture, ['release'], { published: '0.0.3 0.0.1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curl.length, 3);
  assert.ok(gh.at(-1).notes.endsWith('## Changes\n\n- docs: 更新扩展描述\n- feat(protocol): 新增事件\n- fix: 修复扩展重连\n'));
}));

test('release: fails without creating a Release when the baseline tag cannot be confirmed', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, gh } = run(fixture, ['release'], { statusSeq: '200 503' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot determine whether extension-v0\.0\.2 is published to GitHub Packages \(HTTP 503\)/);
  assert.ok(gh.every((call) => call.args[1] === 'view'));
}));

test('release: skips without querying when the Release already exists', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, curl, gh } = run(fixture, ['release'], { releaseExists: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curl.length, 0);
  assert.deepEqual(gh.map((call) => call.args.slice(0, 2)), [['release', 'view']]);
}));

test('release: skips without writing to GitHub when the version is not published yet', () => withFixture((fixture) => {
  for (const tagged of [true, false]) {
    if (tagged) tagV3(fixture);
    else git(fixture.repo, 'tag', '-d', 'extension-v0.0.3');
    const { result, curl, gh } = run(fixture, ['release'], { status: '404', published: '0.0.1 0.0.2' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(curl.length, 1);
    assert.match(result.stdout, /not published to GitHub Packages yet/);
    assert.ok(gh.every((call) => call.args[1] === 'view'));
  }
}));

test('release: fails and asks for a manual tag when the version is published but the tag is missing', () => withFixture((fixture) => {
  const { result, gh } = run(fixture, ['release']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is published but the tag extension-v0\.0\.3 is missing.*tag it manually/);
  assert.equal(gh.length, 0);
}));

test('release: fails without writing to GitHub when the registry status is unknown or the version is invalid', () => withFixture((fixture) => {
  tagV3(fixture);
  const unknown = run(fixture, ['release'], { status: '503' });
  assert.notEqual(unknown.result.status, 0);
  assert.match(unknown.result.stderr, /HTTP 503/);
  assert.ok(unknown.gh.every((call) => call.args[1] === 'view'));

  const invalid = run(fixture, ['release', '0.0.3;touch x']);
  assert.match(invalid.result.stderr, /Invalid version format/);
  assert.equal(invalid.curl.length + invalid.gh.length, 0);
}));

test('release: fails without a token instead of querying GitHub Packages', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, curl, gh } = run(fixture, ['release'], { token: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GH_TOKEN \(or GITHUB_TOKEN\) is required/);
  assert.equal(curl.length, 0);
  assert.equal(gh.length, 0);
}));

test('fails on an unknown subcommand or wrong argument count', () => withFixture((fixture) => {
  for (const args of [[], ['publish'], ['tag', '0.0.3'], ['release', '0.0.3', 'extra']]) {
    const { result, gh } = run(fixture, args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /Usage:/);
    assert.equal(gh.length, 0);
  }
}));
