import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { roleSection, briefSection, CX_CHECKLIST, MOCKUP_DIR } from './IWorker.js';
import { designerScopeViolation } from './Factory.js';
import { validateBlueprint, type PlanningInput } from './Planner.js';

/** 6.1 foundation: designer and CX reviewer roles. */
const diffOf = (...files: string[]) => files.map(f => `diff --git a/${f} b/${f}\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+x\n`).join('');

describe('designer and cx_reviewer roles', () => {
  it('give a designer the mockup path, the states to draw and the project design system', () => {
    const text = roleSection({ id: 'T1', agent_role: 'designer' }, '## Tokens\n- src/theme.css');
    assert.match(text, /ROLE: DESIGNER/);
    assert.ok(text.includes(`${MOCKUP_DIR}/T1-<screen>.html`));
    assert.match(text, /empty, error and loading/);
    assert.match(text, /src\/theme\.css/);
    assert.match(briefSection({ out_of_scope: [], notes_to_executor: [] }, undefined, text), /ROLE: DESIGNER/);
  });

  it('give a CX reviewer all ten checklist items, and other roles nothing', () => {
    const text = roleSection({ id: 'T3', agent_role: 'cx_reviewer' });
    assert.equal(CX_CHECKLIST.length, 10);
    for (const item of CX_CHECKLIST) assert.ok(text.includes(item), item);
    assert.equal(roleSection({ id: 'T2', agent_role: 'coder' }), '');
  });

  it('reject a designer diff that touches application code or writes no mockup', () => {
    const designer = { id: 'T1', agent_role: 'designer' };
    assert.equal(designerScopeViolation(designer, diffOf(`${MOCKUP_DIR}/T1-dashboard.html`)), null);
    assert.match(designerScopeViolation(designer, diffOf(`${MOCKUP_DIR}/T1-dashboard.html`, 'src/App.tsx'))!, /touches src\/App\.tsx/);
    assert.match(designerScopeViolation(designer, diffOf(`${MOCKUP_DIR}/notes.md`))!, /No mockup was written/);
    assert.equal(designerScopeViolation({ id: 'T2', agent_role: 'coder' }, diffOf('src/App.tsx')), null);
  });

  it('reject a plan that gives a designer files outside the mockup directory', () => {
    const input: PlanningInput = { requirement: 'Add a dashboard.', codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['src/App.tsx']) };
    const task = { id: 'T1', title: 'Design the dashboard', description: 'Mockups for the dashboard.', agent_role: 'designer', phase: 1, dependencies: [], blockedBy: [], files_hint: ['src/App.tsx'], creates_files: [`${MOCKUP_DIR}/T1-dashboard.html`], acceptance_criteria: ['mockup exists'], verification: [`ls ${MOCKUP_DIR}/T1-dashboard.html`], verification_command: `ls ${MOCKUP_DIR}/T1-dashboard.html`, executor: 'agent' };
    assert.throws(() => validateBlueprint({ feature: 'Dashboard', requirements_covered: [], tasks: [task] }, input), /T1 is a designer but lists files outside softfactory-design\/mockups\/: src\/App\.tsx/);
  });
});
