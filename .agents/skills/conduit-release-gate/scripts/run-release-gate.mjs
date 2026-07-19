#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, '../../../..');
const cli = join(repo, 'cli');

const args = new Set(process.argv.slice(2));
const allowDirty = args.has('--allow-dirty');
const skipInstall = args.has('--skip-install');
const skipE2e = args.has('--skip-e2e');
const keepTemp = args.has('--keep-temp');
const artifactArg = process.argv.indexOf('--artifact-dir');
const artifactDir = artifactArg >= 0 ? resolve(process.argv[artifactArg + 1] ?? '') : null;

let tempRoot;
let createdWranglerConfig = false;
let createdWorkerTypes = false;

function section(message) {
  console.log(`\n==> ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repo,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
    fail(`${command} ${commandArgs.join(' ')} exited ${result.status}${detail}`);
  }
  return (result.stdout ?? '').trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function ensureTestConfig(env) {
  const wranglerConfig = join(repo, 'wrangler.jsonc');
  const workerTypes = join(repo, 'worker-configuration.d.ts');
  if (!existsSync(wranglerConfig)) {
    copyFileSync(join(repo, 'wrangler.example.jsonc'), wranglerConfig);
    createdWranglerConfig = true;
  }
  if (!existsSync(workerTypes)) {
    run(join(repo, 'node_modules/.bin/wrangler'), ['types', '--config', wranglerConfig], { env });
    createdWorkerTypes = true;
  }
}

function parsePackResult(output) {
  const start = output.indexOf('[');
  if (start < 0) fail(`npm pack did not return JSON: ${output}`);
  const parsed = JSON.parse(output.slice(start));
  if (!Array.isArray(parsed) || parsed.length !== 1) fail('npm pack returned an unexpected result');
  return parsed[0];
}

function inspectPack(pack, manifest) {
  if (pack.name !== manifest.name || pack.version !== manifest.version) {
    fail(`packed identity ${pack.name}@${pack.version} does not match package.json`);
  }
  const expected = ['LICENSE', 'README.md', 'dist/conduit.js', 'package.json'];
  const actual = pack.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`unexpected tarball files: ${actual.join(', ')}`);
  }
  const executable = pack.files.find((file) => file.path === 'dist/conduit.js');
  if (!executable || (executable.mode & 0o111) === 0) fail('dist/conduit.js is not executable');
}

function writeReleaseTestConfig(configPath) {
  const config = {
    name: 'conduit-release-test',
    main: join(repo, 'src/index.ts'),
    compatibility_date: '2026-06-01',
    assets: {
      directory: join(repo, 'public'),
      binding: 'ASSETS',
      run_worker_first: ['/d/*', '/admin/api/*'],
    },
    r2_buckets: [{ binding: 'BUCKET', bucket_name: 'conduit-release-test-blobs' }],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'conduit-release-test-meta',
        database_id: '11111111-1111-4111-8111-111111111111',
        migrations_dir: join(repo, 'migrations'),
      },
    ],
    vars: {
      ENVIRONMENT: 'development',
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
      DEV_ADMIN_BYPASS: 'true',
      DEV_ADMIN_EMAIL: 'release-gate@conduit.test',
      UPLOAD_PART_SIZE: '5242880',
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function runCli(bin, commandArgs, env) {
  return run(bin, commandArgs, { cwd: repo, env, capture: true });
}

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((accept) => server.close(accept));
  if (!port) fail('could not allocate a local test port');
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((accept) => child.once('close', accept)),
    delay(3000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runE2e(bin, env) {
  section('Black-box packed CLI ↔ local Worker journey');
  const e2eDir = join(tempRoot, 'e2e');
  const persistDir = join(e2eDir, 'state');
  const xdgDir = join(e2eDir, 'xdg');
  mkdirSync(persistDir, { recursive: true });
  mkdirSync(xdgDir, { recursive: true });
  const configPath = join(e2eDir, 'wrangler.release-test.json');
  const emptyEnvPath = join(e2eDir, 'empty.env');
  writeReleaseTestConfig(configPath);
  writeFileSync(emptyEnvPath, '');

  const wrangler = join(repo, 'node_modules/.bin/wrangler');
  const workerEnv = {
    ...env,
    CI: 'true',
    XDG_CONFIG_HOME: xdgDir,
    WRANGLER_SEND_METRICS: 'false',
  };
  run(
    wrangler,
    ['d1', 'migrations', 'apply', 'conduit-release-test-meta', '--local', '--config', configPath, '--persist-to', persistDir],
    { env: workerEnv },
  );

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const worker = spawn(
    wrangler,
    [
      'dev',
      '--config',
      configPath,
      '--env-file',
      emptyEnvPath,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      persistDir,
    ],
    { cwd: repo, env: { ...process.env, ...workerEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let workerOutput = '';
  worker.stdout.on('data', (chunk) => {
    workerOutput = (workerOutput + chunk.toString()).slice(-12000);
  });
  worker.stderr.on('data', (chunk) => {
    workerOutput = (workerOutput + chunk.toString()).slice(-12000);
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (worker.exitCode !== null) fail(`wrangler dev exited early:\n${workerOutput}`);
      try {
        const response = await fetch(`${endpoint}/admin/api/whoami`);
        if (response.ok && response.headers.get('X-Conduit-Api-Version') === '1') {
          ready = true;
          break;
        }
      } catch {
        // Worker is still starting.
      }
      await delay(100);
    }
    if (!ready) fail(`local Worker did not become ready:\n${workerOutput}`);

    const cliEnv = {
      ...env,
      XDG_CONFIG_HOME: xdgDir,
      NO_COLOR: '1',
      CONDUIT_ENDPOINT: endpoint,
      CONDUIT_ACCESS_CLIENT_ID: '',
      CONDUIT_ACCESS_CLIENT_SECRET: '',
    };
    const doctor = runCli(bin, ['doctor'], cliEnv);
    if (!doctor.includes('All systems go.')) fail(`doctor failed:\n${doctor}`);

    const fixture = join(e2eDir, 'release smoke ü.txt');
    const body = 'packed CLI to local Worker\n';
    writeFileSync(fixture, body);
    const pushed = JSON.parse(runCli(bin, ['push', fixture, '--json', '--no-copy'], cliEnv));
    if (!pushed.file?.id || !pushed.link?.url) fail('push --json returned an incomplete result');

    const files = JSON.parse(runCli(bin, ['ls', '--json'], cliEnv));
    if (!files.some((file) => file.id === pushed.file.id)) fail('ls did not return the uploaded file');

    const first = await fetch(pushed.link.url);
    if (!first.ok || (await first.text()) !== body) fail('first capability download failed');
    const second = await fetch(pushed.link.url);
    if ((await second.text()).includes(body)) fail('single-use capability was reusable');

    let audited = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const pulls = JSON.parse(runCli(bin, ['pulls', '--json'], cliEnv));
      if (pulls.some((pull) => pull.status === 'ok' && pull.file_name === basename(fixture))) {
        audited = true;
        break;
      }
      await delay(100);
    }
    if (!audited) fail('successful download did not appear in pulls');

    runCli(bin, ['rm', pushed.file.id, '--yes'], cliEnv);
    const afterDelete = JSON.parse(runCli(bin, ['ls', '--json'], cliEnv));
    if (afterDelete.some((file) => file.id === pushed.file.id)) fail('rm did not delete the uploaded file');

    const largeFixture = join(e2eDir, 'multipart.bin');
    const largeBody = Buffer.alloc(6 * 1024 * 1024);
    for (let index = 0; index < largeBody.length; index++) largeBody[index] = index % 251;
    writeFileSync(largeFixture, largeBody);
    const largePush = JSON.parse(
      runCli(bin, ['push', largeFixture, '--no-link', '--json', '--no-copy'], cliEnv),
    );
    if (!largePush.file?.id || largePush.link) fail('multipart --no-link upload returned an invalid result');
    const largeLink = JSON.parse(
      runCli(bin, ['link', largePush.file.id, '--json', '--no-copy'], cliEnv),
    );
    const largeDownload = await fetch(largeLink.link?.url);
    if (!largeDownload.ok) fail('multipart capability download failed');
    const downloaded = Buffer.from(await largeDownload.arrayBuffer());
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    if (digest(downloaded) !== digest(largeBody)) fail('multipart download content mismatch');
    runCli(bin, ['rm', largePush.file.id, '--yes', '--json'], cliEnv);
    const revoked = await fetch(largeLink.link.url);
    if (!(await revoked.text()).includes('no longer available')) {
      fail('deletion did not revoke the multipart link');
    }
  } finally {
    await stopChild(worker);
  }
}

async function main() {
  const rootManifest = readJson(join(repo, 'package.json'));
  const cliManifest = readJson(join(cli, 'package.json'));
  const rootLock = readJson(join(repo, 'package-lock.json'));
  const cliLock = readJson(join(cli, 'package-lock.json'));
  if (rootManifest.private !== true) fail('Worker package must remain private');
  if (cliManifest.private === true || cliManifest.name !== '@sqcode/conduit') {
    fail('CLI package identity or visibility is incorrect');
  }
  const versions = [
    rootManifest.version,
    rootLock.version,
    rootLock.packages?.['']?.version,
    cliManifest.version,
    cliLock.version,
    cliLock.packages?.['']?.version,
  ];
  if (!versions.every((version) => version === cliManifest.version)) {
    fail(`root, CLI, and lockfile versions must all equal ${cliManifest.version}`);
  }
  if (readFileSync(join(repo, 'LICENSE'), 'utf8') !== readFileSync(join(cli, 'LICENSE'), 'utf8')) {
    fail('cli/LICENSE must exactly match the repository LICENSE');
  }
  if (!readFileSync(join(repo, 'CHANGELOG.md'), 'utf8').includes(`## [${cliManifest.version}]`)) {
    fail(`CHANGELOG.md has no ${cliManifest.version} release entry`);
  }
  for (const workflowName of ['ci.yml', 'publish.yml']) {
    const workflowPath = join(repo, '.github', 'workflows', workflowName);
    const workflow = readFileSync(workflowPath, 'utf8');
    const actionRefs = [...workflow.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
    if (actionRefs.length === 0) fail(`${workflowName} contains no external action references`);
    for (const actionRef of actionRefs) {
      if (!/@[0-9a-f]{40}$/i.test(actionRef)) {
        fail(`${workflowName} action ${actionRef} must be pinned to a full commit SHA`);
      }
    }
  }
  if (process.env.GITHUB_EVENT_NAME === 'release') {
    const expectedTag = `v${cliManifest.version}`;
    if (process.env.GITHUB_REF_NAME !== expectedTag) {
      fail(`release tag ${process.env.GITHUB_REF_NAME ?? '(none)'} must equal ${expectedTag}`);
    }
  }

  const commit = run('git', ['rev-parse', 'HEAD'], { capture: true });
  const dirty = run('git', ['status', '--porcelain'], { capture: true });
  console.log(`Candidate: ${commit} · @sqcode/conduit ${cliManifest.version}`);
  if (dirty && !allowDirty) fail('release candidate worktree is dirty (use --allow-dirty only while developing)');
  if (dirty) console.log('Worktree: dirty (development override accepted)');

  tempRoot = mkdtempSync(join(tmpdir(), 'conduit-release-'));
  const unitConfigPath = join(tempRoot, 'wrangler.unit-test.json');
  writeReleaseTestConfig(unitConfigPath);
  const env = {
    XDG_CONFIG_HOME: join(tempRoot, 'xdg'),
    CONDUIT_TEST_WRANGLER_CONFIG: unitConfigPath,
    npm_config_cache: join(tempRoot, 'npm-cache'),
    npm_config_engine_strict: 'true',
    NO_UPDATE_NOTIFIER: '1',
    WRANGLER_SEND_METRICS: 'false',
  };
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  ensureTestConfig(env);

  section('Worker typecheck and tests');
  run('npm', ['run', 'typecheck'], { env });
  run('npm', ['test'], { env });

  section('CLI typecheck, tests, and build');
  run('npm', ['run', 'typecheck'], { cwd: cli, env });
  run('npm', ['test'], { cwd: cli, env });
  run('npm', ['run', 'build'], { cwd: cli, env });

  const sourceVersion = run(process.execPath, [join(cli, 'dist/conduit.js'), '--version'], {
    capture: true,
    env,
  });
  if (sourceVersion !== cliManifest.version) {
    fail(`built CLI reports ${sourceVersion}; package.json says ${cliManifest.version}`);
  }

  section('Pack and inspect the npm artifact');
  const packDir = join(tempRoot, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packOutput = run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
    { cwd: cli, env, capture: true },
  );
  const pack = parsePackResult(packOutput);
  inspectPack(pack, cliManifest);
  const tarball = join(packDir, pack.filename);
  if (!existsSync(tarball)) fail(`tarball missing: ${tarball}`);

  let bin = join(cli, 'dist/conduit.js');
  if (!skipInstall) {
    section('Install and smoke-test the exact tarball');
    const installDir = join(tempRoot, 'install');
    mkdirSync(installDir, { recursive: true });
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installDir, tarball],
      { env },
    );
    bin = join(installDir, 'node_modules/.bin/conduit');
    chmodSync(bin, 0o755);
    const installedVersion = runCli(bin, ['--version'], env);
    if (installedVersion !== cliManifest.version) {
      fail(`installed CLI reports ${installedVersion}; package.json says ${cliManifest.version}`);
    }
    if (!runCli(bin, ['--help'], env).includes('Send single-use file links')) {
      fail('installed CLI help smoke test failed');
    }
  }

  if (!skipE2e) await runE2e(bin, env);

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    const retained = join(artifactDir, basename(tarball));
    cpSync(tarball, retained);
    console.log(`RELEASE_TARBALL=${retained}`);
  }
  console.log('\nPASS: deterministic Conduit release checks completed.');
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (createdWorkerTypes) rmSync(join(repo, 'worker-configuration.d.ts'), { force: true });
  if (createdWranglerConfig) rmSync(join(repo, 'wrangler.jsonc'), { force: true });
  if (tempRoot && !keepTemp) rmSync(tempRoot, { recursive: true, force: true });
  else if (tempRoot) console.log(`Temporary files retained at ${tempRoot}`);
}
