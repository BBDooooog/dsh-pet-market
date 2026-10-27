import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPack } from './pack-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const out = join(HERE, 'dist')
// The published demo ships one dog. Pass ids to build more, e.g.
// `node demo/build-dog-pack.mjs yellow-dog yellow-dog-2`.
const ids = process.argv.slice(2)
for (const id of ids.length ? ids : ['yellow-dog']) {
  console.log(JSON.stringify(buildPack(join(HERE, 'packs', id), out), null, 2))
}
