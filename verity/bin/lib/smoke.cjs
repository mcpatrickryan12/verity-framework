// UI-smoke "observably-works" gate (framework-spec.md §6, the N2 highest-leverage
// gate). Drives the REAL UI and asserts BEHAVIOR — the class of failure (dead button,
// HTMX stub, cache-stale UI) that CI and /health pass while shipping broken.
//
// Capability-gated (needs a headless browser): if none is available the gate DEGRADES
// to a non-pass ("manual Handoff Tester required") — never a false green. The browser
// driver + the capability probe are injectable so the orchestration is testable.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'smoke.json.tmpl');

function specPath(cwd) {
  return path.join(cwd, '.verity', 'smoke.json');
}

function loadSpec(cwd) {
  const p = specPath(cwd);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function validateSpec(spec) {
  const issues = [];
  if (!spec || !Array.isArray(spec.flows)) {
    issues.push('spec.flows must be an array');
  } else {
    spec.flows.forEach((f, i) => {
      if (!f.name) {
        issues.push(`flow ${i}: missing name`);
      }
      if (!Array.isArray(f.steps)) {
        issues.push(`flow ${i}: steps must be an array`);
      }
    });
  }
  return { valid: issues.length === 0, issues };
}

// Translate a declarative flow into a self-contained Playwright script (pure → testable).
function buildScript(baseUrl, flow) {
  const lines = [
    "const { chromium } = require('playwright');",
    '(async () => {',
    '  const browser = await chromium.launch();',
    '  const page = await browser.newPage();',
    '  try {',
  ];
  for (const step of flow.steps) {
    if ('goto' in step) {
      const url = /^https?:/.test(step.goto) ? step.goto : `${baseUrl || ''}${step.goto}`;
      lines.push(`    await page.goto(${JSON.stringify(url)});`);
    } else if ('click' in step) {
      lines.push(`    await page.click(${JSON.stringify(step.click)});`);
    } else if ('fill' in step) {
      lines.push(
        `    await page.fill(${JSON.stringify(step.fill)}, ${JSON.stringify(step.value || '')});`,
      );
    } else if ('expectSelector' in step) {
      lines.push(
        `    await page.waitForSelector(${JSON.stringify(step.expectSelector)}, { timeout: 8000 });`,
      );
    } else if ('expectText' in step) {
      lines.push(
        `    { const _c = await page.content(); if (!_c.includes(${JSON.stringify(step.expectText)})) throw new Error('missing text: ' + ${JSON.stringify(step.expectText)}); }`,
      );
    }
  }
  lines.push(
    '    await browser.close();',
    '  } catch (e) {',
    '    await browser.close();',
    '    console.error(e.message);',
    '    process.exit(1);',
    '  }',
    '})();',
  );
  return lines.join('\n');
}

function resolvableFrom(pkg, cwd) {
  try {
    require.resolve(pkg, { paths: [cwd, process.cwd()] });
    return true;
  } catch {
    return false;
  }
}

function onPath(bin, pathDirs) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  return pathDirs.some((d) => exts.some((e) => fs.existsSync(path.join(d, bin + e))));
}

// Capability probe — is a headless browser usable here? Checks three honest sources
// so we don't false-skip when the tool is installed in a non-local layout:
//   1. the project's local node_modules/.bin
//   2. resolvable as a package from cwd (hoisted / monorepo / npm-linked global)
//   3. a CLI on PATH (a globally-installed playwright)
// Pure (no execution). If none match it returns unavailable, and runSmoke degrades
// to a non-pass — never a false green. Callers can bypass detection entirely by
// injecting opts.probe / opts.driver into runSmoke (e.g. a project-specific runner).
function defaultProbe(cwd, env = process.env) {
  const pathDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const bin of ['playwright', 'puppeteer']) {
    if (
      fs.existsSync(path.join(cwd, 'node_modules', '.bin', bin)) ||
      resolvableFrom(bin, cwd) ||
      onPath(bin, pathDirs)
    ) {
      return { available: true, tool: bin };
    }
  }
  return { available: false, tool: null };
}

function playwrightDriver(cwd) {
  return (baseUrl, flow) => {
    execFileSync('node', ['-e', buildScript(baseUrl, flow)], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
}

function runSmoke(cwd, opts = {}) {
  const spec = opts.spec || loadSpec(cwd);
  if (!spec) {
    throw new Error('no smoke spec — run `verity smoke init` then edit .verity/smoke.json');
  }
  const v = validateSpec(spec);
  if (!v.valid) {
    throw new Error(`invalid smoke spec: ${v.issues.join('; ')}`);
  }
  const probe = opts.probe ? opts.probe(cwd) : defaultProbe(cwd);
  if (!probe.available) {
    return {
      gate: 'skipped',
      verified: false,
      reason:
        'no headless browser available — run /verity:verify (Handoff Tester) manually. This is NOT a pass.',
      flows: [],
      raw: 'skipped',
    };
  }
  const baseUrl = opts.baseUrl || spec.baseUrl || '';
  const driver = opts.driver || playwrightDriver(cwd);
  const flows = spec.flows.map((f) => {
    try {
      driver(baseUrl, f);
      return { name: f.name, passed: true };
    } catch (e) {
      return { name: f.name, passed: false, error: e.message };
    }
  });
  const verified = flows.length > 0 && flows.every((f) => f.passed);
  return {
    gate: verified ? 'passed' : 'failed',
    verified,
    reason: verified ? 'all flows passed' : 'one or more flows failed',
    flows,
    raw: verified ? 'passed' : 'failed',
  };
}

function init(cwd, opts = {}) {
  const p = specPath(cwd);
  if (fs.existsSync(p) && !opts.force) {
    return { created: false, path: p };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, fs.readFileSync(TEMPLATE, 'utf8'));
  return { created: true, path: p };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0] || 'run';
  if (verb === 'init') {
    return init(cwd, { force: Boolean(flags.force) });
  }
  if (verb === 'run') {
    return runSmoke(cwd, { baseUrl: flags['base-url'] });
  }
  throw new Error(`unknown smoke verb: ${verb} — use init|run`);
}

module.exports = {
  specPath,
  loadSpec,
  validateSpec,
  buildScript,
  defaultProbe,
  runSmoke,
  init,
  dispatch,
};
