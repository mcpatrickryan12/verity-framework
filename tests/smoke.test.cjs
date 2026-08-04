const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const smoke = require('../verity/bin/lib/smoke.cjs');

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-smoke-'));
}

const FLOW = {
  name: 'help opens',
  steps: [
    { goto: '/' },
    { fill: '#email', value: 'a@b.c' },
    { click: '#help-button' },
    { expectSelector: '#help-panel' },
    { expectText: 'How can I help' },
  ],
};

test('buildScript translates a flow into a Playwright script', () => {
  const s = smoke.buildScript('http://localhost:3000', FLOW);
  assert(s.includes("require('playwright')"), 'uses playwright');
  assert(s.includes('page.goto("http://localhost:3000/")'), 'goto joins baseUrl');
  assert(s.includes('page.fill("#email", "a@b.c")'), 'fill with value');
  assert(s.includes('page.click("#help-button")'), 'click');
  assert(s.includes('waitForSelector("#help-panel"'), 'expectSelector');
  assert(s.includes('missing text: '), 'expectText assertion');
});

test('validateSpec catches malformed specs', () => {
  assert(smoke.validateSpec({ flows: [{ name: 'x', steps: [] }] }).valid, 'valid spec');
  assert(!smoke.validateSpec({}).valid, 'no flows -> invalid');
  assert(!smoke.validateSpec({ flows: [{ steps: [] }] }).valid, 'flow without name -> invalid');
});

test('HONEST DEGRADE: no browser -> skipped, verified=false (never a false green)', () => {
  const r = smoke.runSmoke(fresh(), {
    spec: { flows: [FLOW] },
    probe: () => ({ available: false, tool: null }),
  });
  assertEqual(r.gate, 'skipped');
  assertEqual(r.verified, false, 'a missing browser must NOT count as verified');
  assert(/NOT a pass/i.test(r.reason), 'reason makes the non-pass explicit');
});

test('with a browser + passing driver -> verified', () => {
  const r = smoke.runSmoke(fresh(), {
    spec: { flows: [FLOW] },
    probe: () => ({ available: true, tool: 'playwright' }),
    driver: () => {}, // pretends every flow passes
  });
  assertEqual(r.verified, true);
  assertEqual(r.flows[0].passed, true);
});

test('a failing flow fails the gate', () => {
  const r = smoke.runSmoke(fresh(), {
    spec: { flows: [FLOW, { name: 'broken', steps: [] }] },
    probe: () => ({ available: true, tool: 'playwright' }),
    driver: (_base, flow) => {
      if (flow.name === 'broken') {
        throw new Error('dead button');
      }
    },
  });
  assertEqual(r.verified, false, 'one failing flow fails the gate');
  assert(r.flows.find((f) => f.name === 'broken').error.includes('dead button'));
});

// --- capability probe: detects more than the local node_modules/.bin ---
test('defaultProbe finds a browser in the local node_modules/.bin', () => {
  const d = fresh();
  const bin = path.join(d, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'playwright'), '');
  const r = smoke.defaultProbe(d, { PATH: '' });
  assert(r.available && r.tool === 'playwright', 'local .bin still detected');
});

test('defaultProbe finds a globally-installed browser on PATH (not just local .bin)', () => {
  const d = fresh(); // empty project — no local node_modules
  const pathDir = fresh();
  fs.writeFileSync(path.join(pathDir, 'playwright'), '');
  const r = smoke.defaultProbe(d, { PATH: pathDir });
  assert(r.available && r.tool === 'playwright', 'PATH-installed tool detected');
});

test('defaultProbe reports unavailable when nothing is found (degrades, never false green)', () => {
  const r = smoke.defaultProbe(fresh(), { PATH: '' });
  assertEqual(r.available, false);
  assertEqual(r.tool, null);
});

test('runSmoke with no spec throws', () => {
  let failed = false;
  try {
    smoke.runSmoke(fresh(), {});
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'missing spec should throw');
});

test('smoke init scaffolds .verity/smoke.json', () => {
  const d = fresh();
  const r = smoke.init(d);
  assert(r.created && fs.existsSync(r.path), 'spec scaffolded');
  assert(JSON.parse(fs.readFileSync(r.path, 'utf8')).flows.length > 0, 'has example flows');
});
