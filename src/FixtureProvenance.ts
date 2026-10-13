/**
 * Which changed files are fixture data the worker invented, rather than real
 * responses the orchestrator fetched from an external source.
 *
 * The mongolbank-rates run wrote `tests/fixtures/bom_latest.html` from
 * imagination, so 127 tests agreed with each other and with nothing real.
 * This module gives the gate a mechanical way to catch that before review.
 */

const FIXTURE_DIRECTORIES = new Set([
    'fixtures',
    '__fixtures__',
    'testdata',
    'test_data',
    'samples',
    'mocks',
]);

const DATA_EXTENSIONS = /\.(?:html|htm|json|xml|csv|txt)$/i;

function normalized(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function sitsUnderFixtureDirectory(filePath: string): boolean {
    const segments = normalized(filePath).split('/');
    return segments.some(segment => FIXTURE_DIRECTORIES.has(segment.toLowerCase()));
}

function hasDataExtension(filePath: string): boolean {
    return DATA_EXTENSIONS.test(normalized(filePath));
}

/**
 * Returns the files a worker added or modified that stand in for an external
 * source without being fetched from it.
 *
 * A file is flagged when it sits under a fixture directory (`fixtures`,
 * `__fixtures__`, `testdata`, `test_data`, `samples` or `mocks`), has a data
 * extension (`.html .htm .json .xml .csv .txt`) and is not one of the
 * orchestrator-owned probe responses. A probe response path that was itself
 * changed is always flagged: the worker may not edit what the orchestrator
 * saved.
 */
export function inventedFixtures(changedFiles: string[], diff: string, probePaths: string[]): string[] {
    const candidates = new Map<string, string>();
    const add = (filePath: string) => {
        const cleaned = normalized(filePath).trim();
        if (cleaned) candidates.set(cleaned, filePath.trim());
    };
    for (const filePath of changedFiles) add(filePath);
    // The diff is authoritative about what was actually added or modified, so
    // parse its target paths too. This also covers a caller that only passes
    // changedFiles as a convenience subset.
    if (diff) {
        for (const line of diff.split('\n')) {
            const match = line.match(/^\+\+\+\s+b\/(.+)$/);
            if (match) add(match[1]);
        }
    }

    const probes = new Set(probePaths.map(probe => normalized(probe)));
    const flagged: string[] = [];
    for (const [clean, original] of candidates) {
        if (probes.has(clean)) {
            flagged.push(original);
            continue;
        }
        if (sitsUnderFixtureDirectory(clean) && hasDataExtension(clean)) {
            flagged.push(original);
        }
    }
    return flagged;
}
