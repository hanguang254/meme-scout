// The upstream CLI prioritizes its global dotenv. Load that module once, then
// select this monitor's explicit key before the read-only command is evaluated.
await import('../node_modules/gmgn-cli/dist/config.js');
if (process.env.MEME_GMGN_API_KEY)
  process.env.GMGN_API_KEY = process.env.MEME_GMGN_API_KEY;
delete process.env.MEME_GMGN_API_KEY;
delete process.env.GMGN_PRIVATE_KEY;
const [group, command] = process.argv.slice(2);
const allowed = {
  market: ['trending'],
  token: ['info', 'security', 'holders'],
  portfolio: ['created-tokens'],
};
if (!allowed[group]?.includes(command)) {
  console.error('Read-only command not allowed');
  process.exit(1);
}
await import('../node_modules/gmgn-cli/dist/index.js');
