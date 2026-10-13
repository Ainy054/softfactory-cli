import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Common English words that are too generic to point at existing code. A
 * requirement is written in prose, so every sentence would otherwise hand the
 * planner words like "function" or "should" and match half the repository.
 */
const STOP_WORDS = new Set([
    'about', 'after', 'against', 'already', 'another', 'because', 'before', 'between',
    'change', 'changes', 'common', 'create', 'created', 'creates', 'creating', 'current',
    'currently', 'default', 'during', 'either', 'existing', 'feature', 'features',
    'function', 'functions', 'handle', 'handling', 'inside', 'instead', 'method', 'methods',
    'number', 'numbers', 'object', 'objects', 'please', 'provide', 'provided', 'provides',
    'require', 'required', 'requirement', 'requirements', 'return', 'returns', 'should',
    'simple', 'string', 'strings', 'support', 'supports', 'system', 'systems', 'their',
    'there', 'these', 'those', 'through', 'update', 'updated', 'updates', 'using', 'value',
    'values', 'where', 'whether', 'which', 'while', 'within', 'without', 'would',
]);

const MAX_TERMS = 12;
const MAX_LINES = 15;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_LINE_CHARS = 120;

const LOCKFILES = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-lock.yml',
    'bun.lockb', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum',
    'packages.lock.json',
]);

/** Generated, vendored and dependency-locked files never describe the feature. */
function isSkipped(file: string): boolean {
    const segments = file.split(/[\\/]+/);
    if (segments.some(segment => segment === 'node_modules' || segment === 'dist')) return true;
    const base = (segments[segments.length - 1] || '').toLowerCase();
    if (LOCKFILES.has(base)) return true;
    if (base.endsWith('.lock')) return true;
    if (/(^|[.-])lock\.(json|ya?ml)$/.test(base)) return true;
    return false;
}

/**
 * Candidate terms, strongest signal first: identifiers the requirement puts in
 * backticks, then CamelCase/snake_case names of 5+ characters, then nouns of 6+
 * letters that are not common English words. At most 12.
 */
function candidateTerms(requirement: string): string[] {
    const terms: string[] = [];
    const seen = new Set<string>();
    const add = (raw: string, minLength = 3) => {
        const term = raw.trim();
        if (term.length < minLength) return;
        const key = term.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        terms.push(term);
    };

    // 1. Identifiers in backticks. These are explicit code names, so even
    // short identifiers (`go`, `id`) are strong signals and are kept verbatim.
    for (const match of requirement.matchAll(/`([^`]+)`/g)) {
        for (const part of match[1].split(/[^A-Za-z0-9_$]+/)) add(part, 1);
    }
    // 2. CamelCase or snake_case words of 5+ characters.
    for (const match of requirement.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
        const word = match[0];
        if (word.length >= 5 && (/[a-z][A-Z]/.test(word) || word.includes('_') || /[A-Z][a-z]/.test(word))) add(word);
    }
    // 3. Nouns of 6+ letters that are not common English words.
    for (const match of requirement.matchAll(/[A-Za-z]{6,}/g)) {
        const word = match[0];
        if (!STOP_WORDS.has(word.toLowerCase())) add(word);
    }
    return terms.slice(0, MAX_TERMS);
}

interface Hit {
    file: string;
    terms: string[];
    line: number;
    text: string;
}

/**
 * Search the tracked files for what the requirement names, so the planner is
 * told what is already there instead of rebuilding it. Returns formatted
 * evidence lines, strongest files (most distinct terms) first.
 */
export async function scout(baseDir: string, requirement: string, files: string[]): Promise<string[]> {
    const terms = candidateTerms(requirement || '');
    if (terms.length === 0) return [];
    const tracked = [...new Set(files)].filter(file => file && !isSkipped(file));
    if (tracked.length === 0) return [];

    const hits: Hit[] = [];
    for (const file of tracked) {
        let content: string;
        try {
            const stat = await fs.stat(path.join(baseDir, file));
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
            content = await fs.readFile(path.join(baseDir, file), 'utf8');
        } catch {
            continue;
        }
        // A binary file (a committed .pyc, an image) is not evidence, and its
        // NUL bytes would end up in the planner's command line.
        if (content.includes('\0')) continue;

        const lowerPath = file.toLowerCase();
        const lines = content.split('\n');
        const lowerLines = lines.map(line => line.toLowerCase());

        const matched: string[] = [];
        let line = 0;
        let text = '';
        for (const term of terms) {
            const lower = term.toLowerCase();
            const inPath = lowerPath.includes(lower);
            const lineIndex = lowerLines.findIndex(candidate => candidate.includes(lower));
            if (!inPath && lineIndex < 0) continue;
            matched.push(term);
            if (lineIndex >= 0 && (line === 0 || lineIndex + 1 < line)) {
                line = lineIndex + 1;
                text = lines[lineIndex].trim();
            }
        }
        if (matched.length === 0) continue;
        if (line === 0) text = file; // matched the path only
        hits.push({ file, terms: matched, line, text: text.slice(0, MAX_LINE_CHARS) });
    }

    return hits
        .sort((a, b) => b.terms.length - a.terms.length || a.file.localeCompare(b.file))
        .slice(0, MAX_LINES)
        .map(hit => `- ${hit.file}: mentions ${hit.terms.join(', ')} (line ${hit.line}: ${hit.text})`);
}
