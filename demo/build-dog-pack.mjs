import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPack } from './pack-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const out = join(HERE, 'dist')
for (const id of ['yellow-dog', 'yellow-dog-2']) {
  console.log(JSON.stringify(buildPack(join(HERE, 'packs', id), out), null, 2))
}
