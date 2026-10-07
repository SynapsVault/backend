/**
 * Placeholder env for the test run so modules that import `config` can load
 * without real secrets. Values already set in the environment win.
 */
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://test:test@localhost:5432/synapsvault_test",
  PAY_TO: "GDEJJLXV2CNHF5HEGX34MU4G6L4PRVUAGD4ANF77ZDYTQJKSDSDYVVI6",
  AGENT_SECRET_KEY: "test-agent-secret",
  OPENROUTER_API_KEY: "test-openrouter-key",
  SUPABASE_URL: "https://placeholder.supabase.co",
  SUPABASE_SERVICE_KEY: "test-supabase-key",
  VAULT_REGISTRY_CONTRACT_ID: "CBQEIMSRPSRKJJHGOELZTP3CISZVHZ6WPKZTWJMYZXHFXPGHHWFQBD4H",
  REGISTRY_CONTRACT_ID: "CBQEIMSRPSRKJJHGOELZTP3CISZVHZ6WPKZTWJMYZXHFXPGHHWFQBD4H",
  REGISTRY_SECRET_KEY: "test-registry-secret",
  ADMIN_API_KEY: "test-admin-key",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
