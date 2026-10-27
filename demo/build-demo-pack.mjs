// Builds demo/dist/pixel-cat-<version>.dsppet from demo/packs/pixel-cat.
//
//   node demo/build-demo-pack.mjs
//
// Prints the sha256 of the produced package and validates it with the same code
// path the market uses before it commits a pack.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPack } from './pack-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const result = buildPack(join(HERE, 'packs', 'pixel-cat'), join(HERE, 'dist'))
console.log(JSON.stringify(result, null, 2))
