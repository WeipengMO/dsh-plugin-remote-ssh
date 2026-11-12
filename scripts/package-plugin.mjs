#!/usr/bin/env node
/** Build a local package for the Desktop plugin manager. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const archive = path.join(root, `${manifest.name}-${manifest.version}.tgz`)
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-ssh-package-'))
const packageDir = path.join(stage, 'package')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${String(result.status)}`)
}

try {
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'])
  run(process.execPath, ['scripts/build-client.mjs'])
  fs.mkdirSync(packageDir)
  for (const entry of ['package.json', ...manifest.files]) {
    const source = path.resolve(root, entry)
    if (!source.startsWith(root + path.sep)) throw new Error(`Invalid package entry: ${entry}`)
    fs.cpSync(source, path.join(packageDir, entry), { recursive: true })
  }
  run('tar', ['-czf', archive, '-C', stage, 'package'])
  console.log(`Package: ${archive}`)
  console.log('Quit Desktop, then run:')
  console.log(`dsh plugin --profile desktop add "${archive}"`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
