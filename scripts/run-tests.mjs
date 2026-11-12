#!/usr/bin/env node
/**
 * In-process node:test runner.
 *
 * `node --test` forks one child process per file, which some confined hosts
 * (including the DSH workspace sandbox on Windows) deny with EPERM. Importing
 * every spec into one process preserves the `node:test` output while keeping
 * the suite runnable there. Each spec owns its own servers, ports and temp
 * directories, so co-residency is safe.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const directory = path.join(root, 'test')
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.js'))
  .sort()

if (files.length === 0) {
  console.error('run-tests: no test/*.test.js files found')
  process.exitCode = 1
} else {
  for (const name of files) {
    console.error(`\n=== ${name} ===`)
    await import(pathToFileURL(path.join(directory, name)).href)
  }
}
