import { accessSync, constants, readFileSync, statSync } from 'node:fs'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const developmentManifest = readJson('.claude-plugin/plugin.json')
const releaseManifest = readJson('plugin/.claude-plugin/plugin.json')
const marketplace = readJson('.claude-plugin/marketplace.json')
const tag = process.argv[2]

if (developmentManifest.version !== releaseManifest.version) {
  throw new Error('development and release plugin versions differ')
}
if (tag?.startsWith('v') && tag.slice(1) !== releaseManifest.version) {
  throw new Error(`release tag ${tag} does not match plugin version ${releaseManifest.version}`)
}
if (marketplace.name !== 'agent-comm') throw new Error('unexpected marketplace name')
const entry = marketplace.plugins?.find((plugin) => plugin.name === 'agent-comm')
if (entry?.source !== './plugin') throw new Error('marketplace must publish ./plugin')

for (const path of [
  'plugin/dist/main.js',
  'plugin/dist/schema.store.sql',
  'plugin/dist/schema.hub.sql',
  'plugin/bin/ac',
  'plugin/.mcp.json',
  'plugin/hooks/hooks.json',
]) {
  accessSync(path, constants.R_OK)
}

if ((statSync('plugin/bin/ac').mode & 0o111) === 0) throw new Error('plugin/bin/ac must be executable')
process.stdout.write(`${releaseManifest.version}\n`)
