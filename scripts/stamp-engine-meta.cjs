#!/usr/bin/env node
// Regenerate verity/engine-meta.json from package.json (stage 35).
//
// engine-meta.json is the IN-SUBTREE copy of the version floors the engine reads
// at runtime (see verity/bin/lib/engine-meta.cjs). `verity install` re-stamps it
// into every deployed copy; this stamps the committed checkout copy so it never
// drifts from package.json. The sync test in tests/engine-selfcontained.test.cjs
// fails CI if this was not run after a package.json bump.
const path = require('node:path');
const install = require('../verity/bin/lib/install.cjs');

const rel = install.stampEngineMeta(path.join(__dirname, '..'));
console.log(`stamped ${rel} from package.json`);
