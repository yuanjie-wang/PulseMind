#!/usr/bin/env node
/**
 * 依赖拉取体检 —— 逐个确认 package.json 的依赖能否从 registry 拉取，失败自动降版本重试。
 *
 * 为什么需要它：`npm install` 是一锤子买卖，任何一个包拉不到就整体终止，
 * 而且分不清是网络问题还是版本被撤。本脚本把直接依赖逐个探测：
 *   第 1 步  npm view <pkg>@<range> version —— 元数据能否解析出版本
 *   第 2 步  npm pack <pkg>@<version>       —— tarball 真实下载到临时目录（--fast 跳过）
 *   失败时   从 registry 的版本列表向下逐个试更低版本（--max-downgrades 控制次数）
 *
 * 用法（项目根目录）：
 *   node scripts/check-deps.mjs                        # 全量体检（元数据 + 真实下载）
 *   node scripts/check-deps.mjs --fast                 # 只查元数据，不下载 tarball
 *   node scripts/check-deps.mjs --only react,vite      # 只查指定包
 *   node scripts/check-deps.mjs --spec left-pad@99.0.0 # 追加任意探测点（验证降级链路）
 *   node scripts/check-deps.mjs --fix                  # 把降级结果写成 package.downgrade.json
 *   node scripts/check-deps.mjs --full                 # 收尾在临时目录完整 npm install 演练（跳过生命周期脚本）
 *   node scripts/check-deps.mjs --json report.json     # 机器可读报告
 *
 * 常用参数：--concurrency 4（并发） --timeout 60（单条 npm 命令秒数） --max-downgrades 6 --skip-dev
 *
 * 覆盖范围：只逐个检查 package.json 声明的直接依赖；传递依赖由 --full 的整树安装兜底。
 * 副作用说明：npm pack 会顺带预热 npm 缓存，之后真正 npm install 时这些包不用再下载。
 * 退出码：0 = 全部可拉取；1 = 仍有失败。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

// ---------- 极简 semver（脚本必须零依赖） ----------

function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  if (!A || !B) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] - B[k];
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  const pa = A.pre.split('.');
  const pb = B.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = +x - +y;
      if (d) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 从 range 里抠出最高的 x.y.z 作为降级的基线；range 里没有具体版本（* / latest）返回 null */
function highestInRange(range) {
  const found = [...String(range).matchAll(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g)].map((m) => m[0]);
  if (!found.length) return null;
  return found.sort(cmpVer)[found.length - 1];
}

// ---------- 输出 ----------

const useColor =
  process.stdout.isTTY && !('NO_COLOR' in process.env) && (!IS_WIN || !!process.env.WT_SESSION || !!process.env.TERM_PROGRAM);
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const log = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLines = (s, n = 6) =>
  String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n');

function die(msg) {
  console.error(red(`[check-deps] ${msg}`));
  process.exit(1);
}

// ---------- 参数 ----------

function parseArgs(argv) {
  const o = {
    deep: true,
    concurrency: 4,
    timeoutSec: 60,
    maxDowngrades: 6,
    skipDev: false,
    fix: false,
    json: null,
    only: null,
    specs: [],
    full: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const takeVal = () => {
      if (inline !== null) return inline;
      i++;
      if (i >= argv.length) die(`参数 ${a} 缺少值`);
      return argv[i];
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--fast') o.deep = false;
    else if (a === '--skip-dev') o.skipDev = true;
    else if (a === '--fix') o.fix = true;
    else if (a === '--full') o.full = true;
    else if (a === '--concurrency') o.concurrency = +takeVal();
    else if (a === '--timeout') o.timeoutSec = +takeVal();
    else if (a === '--max-downgrades') o.maxDowngrades = +takeVal();
    else if (a === '--json') o.json = takeVal();
    else if (a === '--only') o.only = String(takeVal()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--spec') o.specs.push(String(takeVal()));
    else die(`未知参数：${a}（--help 查看用法）`);
  }
  if (!(o.concurrency >= 1)) die('--concurrency 必须 ≥ 1');
  if (!(o.timeoutSec >= 5)) die('--timeout 必须 ≥ 5 秒');
  if (!(o.maxDowngrades >= 0)) die('--max-downgrades 必须 ≥ 0');
  return o;
}

function usage() {
  log(`用法：node scripts/check-deps.mjs [选项]

  --fast              只查 registry 元数据，不下载 tarball（快，但发现不了"包被撤/镜像缺包"）
  --only a,b          只检查指定的包
  --spec n@r          追加任意探测点，如 --spec left-pad@99.0.0（验证降级链路用）
  --skip-dev          跳过 devDependencies
  --fix               把降级结果写成 package.downgrade.json（确认后可替换 package.json）
  --full              收尾在临时目录做一次完整 npm install 演练（--ignore-scripts，覆盖传递依赖）
  --json <file>       输出机器可读 JSON 报告
  --concurrency N     并发数（默认 4，太高容易触发 registry 限流）
  --timeout N         单条 npm 命令超时秒数（默认 60；下载类自动放宽到 ≥300s）
  --max-downgrades N  失败时向下尝试的版本个数（默认 6）`);
}

// ---------- npm 子进程 ----------

function quoteArg(a) {
  a = String(a);
  if (IS_WIN) return `"${a.replaceAll('"', '')}"`;
  return /^[A-Za-z0-9@/._~^+=:-]+$/.test(a) ? a : `'${a.replaceAll("'", `'/''`)}'`;
}

/** 跑一条 npm 命令；shell:true + 自行加引号，规避 Windows 上 spawn .cmd 的 EINVAL 与 cmd 的 ^| 转义坑 */
function runNpm(args, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const cmdline = 'npm ' + args.map(quoteArg).join(' ');
    const child = spawn(cmdline, {
      shell: true,
      cwd,
      windowsHide: true,
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', npm_config_fund: 'false', npm_config_audit: 'false' },
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    timer = setTimeout(() => {
      try {
        if (IS_WIN && child.pid) spawn(`taskkill /pid ${child.pid} /T /F`, { shell: true, windowsHide: true });
        else child.kill('SIGKILL');
      } catch {
        /* 尽力而为 */
      }
      finish({
        code: -1,
        stdout,
        stderr: lastLines(stderr) + `\n[check-deps] 超时（${Math.round(timeoutMs / 1000)}s），已终止`,
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ code: -1, stdout, stderr: String(e), timedOut: false }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

/** 把 npm 的失败归类：版本不匹配可降级重试；网络类不该降级（不是版本的锅）；整包 404 降不了级 */
function classify(stderr, timedOut) {
  if (timedOut) return 'timeout';
  if (/No match found for version/i.test(stderr)) return 'no-version';
  if (/E404|\b404\b/.test(stderr) && /Not found/i.test(stderr)) return 'pkg-missing';
  if (
    /\bE(CONN|TIMEDOUT|AI_AGAIN|NOTFOUND|PROTO|PIPE|RESET|FETCH)\b|socket hang up|network|fetch failed|self-signed|certificate|Content-Length mismatch|\b429\b|\b50[234]\b/i.test(
      stderr,
    )
  ) {
    return 'network';
  }
  return 'other';
}

const REASON_TEXT = {
  'pkg-missing': '整个包在 registry 上不存在（404）',
  network: '网络类错误（重试 1 次仍失败）—— 检查代理 / 更换镜像',
  timeout: 'npm 命令超时（重试 1 次仍失败）',
  other: '未知错误',
};

async function probeVersion(spec, ctx) {
  const args = ['view', spec, 'version', '--json'];
  let r = await runNpm(args, { timeoutMs: ctx.timeoutMs, cwd: ROOT });
  let kind = r.code === 0 ? null : classify(r.stderr, r.timedOut);
  if (r.code !== 0 && (kind === 'network' || kind === 'timeout')) {
    await sleep(1500);
    r = await runNpm(args, { timeoutMs: ctx.timeoutMs, cwd: ROOT });
    kind = r.code === 0 ? null : classify(r.stderr, r.timedOut);
  }
  if (r.code === 0) {
    let v = r.stdout.trim();
    try {
      v = JSON.parse(v);
    } catch {
      /* 保留原文 */
    }
    if (Array.isArray(v)) v = v[v.length - 1];
    if (v && typeof v === 'object') v = v.version ?? v.latest ?? null;
    if (typeof v === 'string' && v.trim()) return { ok: true, version: v.trim().replace(/^v/, '') };
    return { ok: false, kind: 'other', stderr: `无法解析 npm view 输出：${r.stdout.slice(0, 120)}` };
  }
  return { ok: false, kind, stderr: lastLines(r.stderr) };
}

/** 真实下载一个 tarball 到临时目录 —— 元数据在、tarball 被撤/镜像缺失，只有这一步能暴露 */
async function packTest(spec, ctx) {
  const r = await runNpm(['pack', spec, '--pack-destination', ctx.tmpDir], {
    timeoutMs: ctx.packTimeoutMs,
    cwd: ROOT,
  });
  if (r.code === 0) return { ok: true };
  return { ok: false, kind: classify(r.stderr, r.timedOut), stderr: lastLines(r.stderr) };
}

/** 从 registry 的完整版本列表里，自请求版本向下逐个试，找到第一个元数据可解析的版本 */
async function findDowngrade(name, range, ctx, { exclude = new Set(), onTry } = {}) {
  const base = highestInRange(range);
  const list = await runNpm(['view', name, 'versions', '--json'], { timeoutMs: ctx.timeoutMs, cwd: ROOT });
  if (list.code !== 0) {
    const kind = classify(list.stderr, list.timedOut);
    return { ok: false, tried: 0, lastKind: kind, detail: `取版本列表失败（${REASON_TEXT[kind] || kind}）` };
  }
  let versions;
  try {
    versions = JSON.parse(list.stdout);
  } catch {
    return { ok: false, tried: 0, lastKind: 'other', detail: '版本列表解析失败' };
  }
  if (!Array.isArray(versions)) {
    return { ok: false, tried: 0, lastKind: 'other', detail: '版本列表格式异常' };
  }
  const basePre = base ? parseVer(base)?.pre != null : true;
  const candidates = versions
    .filter((v) => {
      const p = parseVer(v);
      return p && (basePre || !p.pre);
    })
    .sort((a, b) => cmpVer(b, a))
    .filter((v) => (base ? cmpVer(v, base) < 0 : true))
    .filter((v) => !exclude.has(v));
  if (!candidates.length) {
    return { ok: false, tried: 0, lastKind: 'no-version', detail: 'registry 上没有更低的版本可试' };
  }
  const tries = candidates.slice(0, ctx.maxDowngrades);
  let tried = 0;
  let lastKind = 'no-version';
  for (const v of tries) {
    tried++;
    if (onTry) onTry(v);
    const p = await probeVersion(`${name}@${v}`, ctx);
    if (p.ok) return { ok: true, version: v, tried };
    if (p.kind === 'network' || p.kind === 'timeout') {
      return { ok: false, tried, lastKind: p.kind, detail: `试到 ${v} 时网络失败，中止降级` };
    }
    lastKind = p.kind;
  }
  return { ok: false, tried, lastKind, detail: `向下试了 ${tried} 个版本（最低试到 ${tries[tries.length - 1]}）均不可用` };
}

// ---------- 并发池 ----------

async function pool(items, n, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }
  const startedAt = Date.now();
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  const deps = [];
  const collect = (obj, kind) => {
    for (const [name, range] of Object.entries(obj || {})) deps.push({ name, range, kind, status: null });
  };
  collect(pkg.dependencies, 'prod');
  if (!opts.skipDev) collect(pkg.devDependencies, 'dev');
  collect(pkg.optionalDependencies, 'optional');

  // 本地/占位协议不是"拉取"问题；git 协议 npm view 也无从谈起 —— 标记跳过，不挡道
  for (const d of deps) {
    if (/^(file:|link:|workspace:)/.test(d.range)) {
      d.status = 'skipped';
      d.note = `本地协议 ${d.range}，跳过`;
    }
  }

  for (const s of opts.specs) {
    const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@');
    if (at < 1) die(`--spec 需要 name@range 形式：${s}`);
    deps.push({ name: s.slice(0, at), range: s.slice(at + 1), kind: 'adhoc', status: null });
  }

  if (opts.only) {
    const only = new Set(opts.only);
    const unknown = opts.only.filter((n) => !deps.some((d) => d.name === n));
    if (unknown.length) die(`--only 里的包不在 package.json：${unknown.join(', ')}`);
    for (const d of deps) if (!only.has(d.name) && d.status !== 'skipped') d.status = 'skipped', (d.note = '--only 未选中');
  }

  const checkable = deps.filter((d) => d.status !== 'skipped');
  const npmVer = lastLines((await runNpm(['-v'], { timeoutMs: 20000, cwd: ROOT })).stdout, 1);
  if (!/^\d+\.\d+\.\d+/.test(npmVer)) die(`npm 不可用（PATH 里找不到 npm？）`);
  const registry = lastLines((await runNpm(['config', 'get', 'registry'], { timeoutMs: 20000, cwd: ROOT })).stdout, 1);

  const nameWidth = Math.max(...deps.map((d) => d.name.length), 10);
  const ctx = {
    timeoutMs: opts.timeoutSec * 1000,
    packTimeoutMs: Math.max(opts.timeoutSec * 1000 * 5, 300_000),
    maxDowngrades: opts.maxDowngrades,
    tmpDir: null,
  };

  log(bold(`\n依赖拉取体检 — ${pkg.name}@${pkg.version}`));
  log(
    dim(
      `  ${process.platform}/${process.arch} · node ${process.version} · npm ${npmVer} · registry ${registry}` +
        ` · 并发 ${opts.concurrency} · ${opts.deep ? '元数据 + tarball 下载' : '仅元数据（--fast）'}`,
    ),
  );
  log(dim(`  待检 ${checkable.length} 个（生产 ${checkable.filter((d) => d.kind === 'prod').length} / 开发 ${
    checkable.filter((d) => d.kind === 'dev').length
  } / 追加 ${checkable.filter((d) => d.kind === 'adhoc').length}）\n`));

  // ---- 第 1 步：元数据 ----
  log(bold('── 第 1 步：registry 元数据 ──'));
  let done = 0;
  const line = (dep, mark, paintFn, extra) =>
    log(`  [${String(++done).padStart(String(checkable.length).length)}/${checkable.length}] ${paintFn(mark)} ${dep.name.padEnd(nameWidth)} ${extra}`);

  await pool(checkable, opts.concurrency, async (dep) => {
    const spec = `${dep.name}@${dep.range}`;
    const probe = await probeVersion(spec, ctx);
    if (probe.ok) {
      dep.status = 'ok';
      dep.version = probe.version;
      line(dep, '[ OK ]', green, dim(`${dep.range} → ${probe.version}`));
      return;
    }
    if (probe.kind === 'no-version') {
      line(dep, '[MISS]', yellow, `${dep.range} 无匹配版本，向下尝试降级 …`);
      const d = await findDowngrade(dep.name, dep.range, ctx, {
        onTry: (v) => log(dim(`        ↓ ${dep.name}@${v}`)),
      });
      if (d.ok) {
        dep.status = 'downgraded';
        dep.version = d.version;
        dep.note = `降级 ${dep.range} → ${d.version}`;
        log(`        ${yellow('[DOWN]')} ${dep.name} ${dep.range} → ${d.version}`);
      } else {
        dep.status = 'failed';
        dep.reason = d.lastKind;
        dep.note = d.detail;
        log(`        ${red('[FAIL]')} ${dep.name} ${d.detail}`);
      }
      return;
    }
    dep.status = 'failed';
    dep.reason = probe.kind;
    dep.note = REASON_TEXT[probe.kind] || probe.kind;
    if (probe.kind === 'other') dep.note += `\n${lastLines(probe.stderr, 3)}`;
    line(dep, '[FAIL]', red, dep.range);
  });

  // ---- 第 2 步：真实下载 ----
  if (opts.deep) {
    const toPack = checkable.filter((d) => d.status === 'ok' || d.status === 'downgraded');
    log(bold(`\n── 第 2 步：tarball 真实下载（${toPack.length} 个，下载到临时目录后删除）──`));
    ctx.tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pm-deps-'));
    let pdone = 0;
    const pad = String(toPack.length).length;
    await pool(toPack, opts.concurrency, async (dep) => {
      let r = await packTest(`${dep.name}@${dep.version}`, ctx);
      if (r.ok) {
        log(`  [${String(++pdone).padStart(pad)}/${toPack.length}] ${green('[ OK ]')} ${dep.name}@${dep.version}`);
        return;
      }
      // 网络类失败不该触发降级（不是版本的锅）；404 类（撤包/镜像缺包）才值得向下换版本
      const retryable = r.kind === 'no-version' || r.kind === 'pkg-missing';
      if (!retryable) {
        dep.status = 'failed';
        dep.reason = 'tarball-' + r.kind;
        dep.note = `tarball 下载失败：${REASON_TEXT[r.kind] || r.kind}\n${lastLines(r.stderr, 3)}`;
        log(`  [${String(++pdone).padStart(pad)}/${toPack.length}] ${red('[FAIL]')} ${dep.name}@${dep.version}`);
        return;
      }
      log(
        `  [${String(++pdone).padStart(pad)}/${toPack.length}] ${yellow('[MISS]')} ${dep.name}@${
          dep.version
        } tarball 缺失，向下尝试降级 …`,
      );
      const d = await findDowngrade(dep.name, dep.range, ctx, {
        exclude: new Set([dep.version]),
        onTry: (v) => log(dim(`        ↓ ${dep.name}@${v}`)),
      });
      if (!d.ok) {
        dep.status = 'failed';
        dep.reason = d.lastKind;
        dep.note = d.detail;
        log(`        ${red('[FAIL]')} ${dep.name} ${d.detail}`);
        return;
      }
      const pr = await packTest(`${dep.name}@${d.version}`, ctx);
      if (!pr.ok) {
        dep.status = 'failed';
        dep.reason = 'tarball-' + pr.kind;
        dep.note = `降级到 ${d.version} 后 tarball 仍下载失败`;
        log(`        ${red('[FAIL]')} ${dep.name}@${d.version} tarball 仍失败`);
        return;
      }
      dep.status = 'downgraded';
      dep.version = d.version;
      dep.note = `降级 ${dep.range} → ${d.version}（原版本 tarball 缺失）`;
      log(`        ${yellow('[DOWN]')} ${dep.name} ${dep.range} → ${d.version}`);
    });
  }

  // ---- 汇总 ----
  const okList = checkable.filter((d) => d.status === 'ok');
  const downList = checkable.filter((d) => d.status === 'downgraded');
  const failList = checkable.filter((d) => d.status === 'failed');
  const skipped = deps.filter((d) => d.status === 'skipped');
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

  log(bold(`\n══════ 结果汇总（用时 ${elapsed}s）══════`));
  log(`  ${green('[ OK ]')} ${okList.length} 个可正常拉取`);
  if (downList.length) {
    log(`  ${yellow('[DOWN]')} ${downList.length} 个已自动降级：`);
    for (const d of downList) log(`         ${d.name.padEnd(nameWidth)} ${d.range} → ${yellow(d.version)}  ${dim(`(${d.note})`)}`);
  }
  if (failList.length) {
    log(`  ${red('[FAIL]')} ${failList.length} 个无法拉取：`);
    for (const d of failList) log(`         ${d.name.padEnd(nameWidth)} ${d.range}  ${red(d.note.split('\n')[0])}`);
  }
  if (skipped.length) {
    log(dim(`  [SKIP] ${skipped.length} 个跳过（${[...new Set(skipped.map((d) => d.note))].join('；')}）`));
  }
  if (downList.length) {
    log(`\n  应用降级：npm i ${downList.map((d) => `${d.name}@${d.version}`).join(' ')}`);
  }
  if (failList.some((d) => d.reason === 'network' || d.reason === 'timeout' || /network|timeout/.test(d.reason || ''))) {
    log(yellow('\n  提示：存在网络类失败。国内网络可先换镜像再查一遍：npm config set registry https://registry.npmmirror.com'));
  }
  const NATIVE = ['better-sqlite3', 'sharp', 'electron', 'esbuild', '@electron/rebuild', 'playwright-core'];
  if (deps.some((d) => NATIVE.includes(d.name))) {
    log(
      dim(
        '\n  说明：本脚本只验证 npm 包本身可拉取。better-sqlite3 / sharp / electron 等的二进制在 install/postinstall 阶段另行下载或编译，不在此覆盖。',
      ),
    );
  }

  // ---- 收尾产物 ----
  if (opts.fix && downList.length) {
    const clone = structuredClone(pkg);
    let pinned = 0;
    const pinInto = (obj) => {
      if (!obj) return;
      for (const d of downList) {
        if (Object.prototype.hasOwnProperty.call(obj, d.name)) {
          obj[d.name] = d.version;
          pinned++;
        }
      }
    };
    pinInto(clone.dependencies);
    pinInto(clone.devDependencies);
    pinInto(clone.optionalDependencies);
    if (pinned > 0) {
      const out = path.join(ROOT, 'package.downgrade.json');
      await writeFile(out, JSON.stringify(clone, null, 2) + '\n');
      log(`\n  已生成 ${out}（降级版本已钉死；确认后可改名替换 package.json）`);
    } else {
      log(dim('\n  --fix：降级项都是追加的探测点，不改动 package.json，跳过生成'));
    }
  }
  if (opts.json) {
    const report = {
      meta: {
        project: `${pkg.name}@${pkg.version}`,
        platform: `${process.platform}/${process.arch}`,
        node: process.version,
        npm: npmVer,
        registry,
        deep: opts.deep,
        elapsedSec: +elapsed,
        finishedAt: new Date().toISOString(),
      },
      results: deps.map(({ name, range, kind, status, version = null, reason = null, note = null }) => ({
        name,
        range,
        kind,
        status,
        version,
        reason,
        note,
      })),
    };
    await writeFile(path.resolve(opts.json), JSON.stringify(report, null, 2) + '\n');
    log(dim(`  JSON 报告：${path.resolve(opts.json)}`));
  }

  // ---- 可选：整树安装演练 ----
  if (opts.full) {
    if (failList.length) {
      log(yellow('\n  --full：仍有拉取失败的包，跳过整树安装演练'));
    } else {
      log(bold('\n── 整树安装演练（临时目录，--ignore-scripts，含 package-lock 锁定版本）──'));
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'pm-full-install-'));
      try {
        const clone = structuredClone(pkg);
        const pinInto = (obj) => {
          if (!obj) return;
          for (const d of downList) if (Object.prototype.hasOwnProperty.call(obj, d.name)) obj[d.name] = d.version;
        };
        pinInto(clone.dependencies);
        pinInto(clone.devDependencies);
        pinInto(clone.optionalDependencies);
        await writeFile(path.join(tmp, 'package.json'), JSON.stringify(clone, null, 2) + '\n');
        const lock = path.join(ROOT, 'package-lock.json');
        const hasLock = fs.existsSync(lock);
        if (hasLock) await cp(lock, path.join(tmp, 'package-lock.json'));
        const r = await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
          timeoutMs: 30 * 60_000,
          cwd: tmp,
        });
        if (r.code === 0) {
          log(`  ${green('[ OK ]')} 完整依赖树安装成功${hasLock ? '（含 lockfile）' : ''} —— 传递依赖也可拉取`);
        } else {
          log(`  ${red('[FAIL]')} 整树安装失败（传递依赖层面），末尾输出：`);
          log(dim(lastLines(r.stderr, 15).replace(/^/gm, '    ')));
          process.exitCode = 1;
        }
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (ctx.tmpDir) await rm(ctx.tmpDir, { recursive: true, force: true }).catch(() => {});
  if (failList.length) process.exitCode = 1;
}

process.on('SIGINT', async () => {
  process.exit(130);
});

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
