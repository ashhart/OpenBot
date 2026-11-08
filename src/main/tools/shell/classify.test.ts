import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeCommand } from './classify'

test('a pager flag on a read-only command is analysed as the command it runs', () => {
  const analysis = analyzeCommand('man -P "rm -rf /Users/example" ls')
  assert.equal(analysis.risk, 'high')
  assert.ok(analysis.binaries.includes('rm'))
  assert.equal(analysis.blocked, 'a recursive force-delete of a root, home or system directory')
})

test('the attached form of a pager flag is read the same way', () => {
  const analysis = analyzeCommand('bat --paging=always --pager="rm -rf build" README.md')
  assert.equal(analysis.risk, 'high')
  assert.ok(analysis.binaries.includes('rm'))
})

test('a pager variable in front of a read-only command is analysed as a command', () => {
  const commands = [
    'MANPAGER="rm -rf /Users/example" man ls',
    'env PAGER="sh -c \'rm -rf ~\'" man ls',
    'GIT_PAGER="rm -rf build" git -p log'
  ]
  for (const command of commands) {
    const analysis = analyzeCommand(command)
    assert.equal(analysis.risk, 'high', command)
    assert.ok(analysis.binaries.includes('rm'), command)
  }
})

test('an ordinary pager leaves a read-only command read-only', () => {
  assert.equal(analyzeCommand('man -P cat ls').risk, 'safe')
  assert.equal(analyzeCommand('PAGER=cat man ls').risk, 'safe')
})
