const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');
const ledger = require('../verity/bin/lib/ledger.cjs');

// Build a temp project with 3 dependent stages: 1 <- 2 <- 3.
function project3() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-ledger-'));
  stage.create(d, 'First'); // stage 1, deps none
  stage.create(d, 'Second', { dependsOn: '1' }); // stage 2
  stage.create(d, 'Third', { dependsOn: '2' }); // stage 3
  return d;
}

// Snapshot: stage 1 merged, stage 2 building (PR open, CI red), stage 3 untouched.
const snapshot = {
  online: true,
  issues: [
    { number: 11, title: '[stage 1] First', state: 'CLOSED', assignees: [{ login: 'a' }] },
    { number: 12, title: '[stage 2] Second', state: 'OPEN', assignees: [{ login: 'a' }] },
  ],
  prs: [
    {
      number: 21,
      title: '[stage 1] First',
      state: 'MERGED',
      headRefName: 'feat/stage-1-first',
      ciGreen: true,
    },
    {
      number: 22,
      title: '[stage 2] Second',
      state: 'OPEN',
      headRefName: 'feat/stage-2-second',
      ciGreen: false,
    },
  ],
  tags: ['v0.1.0', 'v0.2.0', 'v0.1.5'],
};

test('readStages parses number, type, and depends-on from the spec files', () => {
  const stages = ledger.readStages(project3());
  assertEqual(stages.length, 3);
  assertEqual(stages[0].number, 1);
  assertEqual(stages[1].dependsOn[0], 1, 'stage 2 depends on 1');
});

test('derives status by correlating specs with GitHub', () => {
  const proj = ledger.project(project3(), { snapshot });
  const byNum = Object.fromEntries(proj.stages.map((s) => [s.number, s.status]));
  assertEqual(byNum[1], 'merged', 'PR merged -> merged');
  assertEqual(byNum[2], 'building', 'PR open + CI red -> building');
  assertEqual(byNum[3], 'planned', 'nothing -> planned');
});

test('next = unblocked (deps merged, not itself merged)', () => {
  const proj = ledger.project(project3(), { snapshot });
  // 1 merged (excluded); 2 deps[1] merged -> unblocked; 3 deps[2] not merged -> blocked.
  assertEqual(JSON.stringify(proj.next), JSON.stringify([2]));
});

test('release is the highest semver tag', () => {
  const proj = ledger.project(project3(), { snapshot });
  assertEqual(proj.release, 'v0.2.0');
});

test('state stage <n> reflects derived status; summary counts by status', () => {
  const proj = ledger.project(project3(), { snapshot });
  const summary = ledger.summarize(proj);
  assertEqual(summary.total, 3);
  assertEqual(summary.byStatus.merged, 1);
  assertEqual(summary.byStatus.building, 1);
  assertEqual(summary.byStatus.planned, 1);
});

test('empty/offline snapshot -> all planned, next is the dependency roots', () => {
  const proj = ledger.project(project3(), {
    snapshot: { online: false, issues: [], prs: [], tags: [] },
  });
  assert(
    proj.stages.every((s) => s.status === 'planned'),
    'no GitHub data -> everything planned',
  );
  assertEqual(
    JSON.stringify(proj.next),
    JSON.stringify([1]),
    'only the root (deps none) is unblocked',
  );
  assertEqual(proj.online, false);
});

test('ledger never writes a state file (read-only derivation)', () => {
  const d = project3();
  const before = fs.readdirSync(d).sort().join(',');
  ledger.project(d, { snapshot });
  const after = fs.readdirSync(d).sort().join(',');
  assertEqual(after, before, 'projection must not create or mutate files');
});
