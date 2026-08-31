// Provider-driver registry (ADR-0005): the one place `agent-exec` looks up a
// model runtime. A driver is a module under this directory exposing the
// provider interface (id, displayName, binaryEnvVar, defaultBinary,
// resolveBinary, checkVersion, readPolicy, renderPrompt, buildArgv, execute,
// parseTranscript, countToolCalls, normalizeUsage, normalizeResult,
// transcriptFilename, supportsMaxTurns, optional annotate — see claude.cjs,
// the reference driver). Adding a runtime is a registry entry plus a driver
// plus fixtures; agent-exec.cjs never changes.
//
// `claude` (stage 7) is the reference driver and the DEFAULT agent; `codex`
// (stage 8, ADR-0005/0009) runs only on an explicit `--agent codex` — the
// worker cannot select it until stage 9.
const { AgentExecError } = require('./result-contract.cjs');

const PROVIDERS = {
  claude: require('./claude.cjs'),
  codex: require('./codex.cjs'),
  grok: require('./grok.cjs'),
};

function listProviders() {
  return Object.keys(PROVIDERS);
}

// Unknown id → stable user-facing error naming the valid providers. Thrown as
// an AgentExecError so agent-exec maps it onto the existing unsupported-agent
// infra path (exit 30 + one stderr line), never a stack trace.
function getProvider(id) {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, id)) {
    throw new AgentExecError(
      `unsupported agent '${id}' — supported providers: ${listProviders().join(', ')}`,
      'unsupported-agent',
    );
  }
  return PROVIDERS[id];
}

module.exports = { getProvider, listProviders };
