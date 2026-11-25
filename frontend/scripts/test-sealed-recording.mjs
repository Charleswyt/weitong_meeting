import assert from 'node:assert/strict'
import { openRecording, sealRecording } from '../src/utils/sealedRecording.ts'

const frame = crypto.getRandomValues(new Uint8Array(24000))
const source = new Blob(Array(55).fill(frame), { type: 'video/mp4' })
const pass = 'acceptance passphrase for a test clip'
const file = await sealRecording(source, pass)
const second = await sealRecording(source, pass)
assert(file.size > source.size)
assert.notDeepEqual(await file.arrayBuffer(), await second.arrayBuffer())
assert.deepEqual(await (await openRecording(file, pass)).arrayBuffer(), await source.arrayBuffer())
await assert.rejects(openRecording(file, 'wrong passphrase'))
await assert.rejects(openRecording(file.slice(0, -1), pass))
const corrupted = new Uint8Array(await file.arrayBuffer())
corrupted[corrupted.length - 1] ^= 1
await assert.rejects(openRecording(new Blob([corrupted]), pass))
console.log(
  'Encrypted recording round-trip, independent keys, wrong password, truncation and tampering passed.',
)
