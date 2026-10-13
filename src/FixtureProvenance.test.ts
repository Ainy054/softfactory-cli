import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventedFixtures } from './FixtureProvenance.js';

test('a new tests/fixtures/page.html is flagged', () => {
    assert.deepEqual(
        inventedFixtures(['tests/fixtures/page.html'], '', []),
        ['tests/fixtures/page.html'],
    );
});

test('a probe path is allowed while unchanged but flagged when edited', () => {
    const probes = ['tests/fixtures/sources/x.json'];
    assert.deepEqual(
        inventedFixtures(['tests/fixtures/sources/x.json'], '', probes),
        ['tests/fixtures/sources/x.json'],
    );
    assert.deepEqual(inventedFixtures([], '', probes), []);
});

test('tests/conftest.py is allowed', () => {
    assert.deepEqual(inventedFixtures(['tests/conftest.py'], '', []), []);
});

test('testdata/sample.json is flagged', () => {
    assert.deepEqual(
        inventedFixtures(['testdata/sample.json'], '', []),
        ['testdata/sample.json'],
    );
});

test('diff target paths are considered even when changedFiles is empty', () => {
    const diff = [
        'diff --git a/tests/fixtures/page.html b/tests/fixtures/page.html',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/tests/fixtures/page.html',
        '+<html></html>',
    ].join('\n');
    assert.deepEqual(inventedFixtures([], diff, []), ['tests/fixtures/page.html']);
});
