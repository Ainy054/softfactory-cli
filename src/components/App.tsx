import React, { useReducer, useEffect, useCallback, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { formatPlan, type PlanDecision } from '../PlanApproval.js';
import { Factory } from '../Factory.js';
import { Task, FactoryState, FactoryEvent } from '../types.js';
import { Header } from './Header.js';
import { PhaseProgress } from './PhaseProgress.js';
import { TaskList } from './TaskList.js';
import { WorkerOutput } from './WorkerOutput.js';
import { appendWorkerLog, normalizeWorkerOutput } from '../workerOutput.js';
import { startFactoryRun } from '../runMode.js';

interface AppProps {
  factory: Factory;
  requirement: string;
  resumeMode?: boolean;
  resumeFeatureId?: string;
  retryBlocked?: boolean;
  refineMode?: boolean;
  planMode?: boolean;
  /** Show the plan and wait for y/n before any worker starts. */
  askForApproval?: boolean;
  /** A person is at the terminal: the planned-budget question is asked here. */
  interactive?: boolean;
}

interface AppState {
  feature: string;
  status: string;
  tasks: Task[];
  currentPhase: number;
  workerLogs: Array<{ taskId: string; line: string }>;
  error: string | null;
  done: boolean;
}

type Action =
  | { type: 'state:update'; state: FactoryState }
  | { type: 'worker:output'; taskId: string; line: string }
  | { type: 'phase:start'; phase: number }
  | { type: 'build:complete'; status: string; feature: string }
  | { type: 'error'; message: string };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'state:update':
      return {
        ...state,
        feature: action.state.feature,
        status: action.state.status,
        tasks: [...action.state.tasks],
      };
    case 'worker:output':
      return {
        ...state,
        workerLogs: appendWorkerLog(state.workerLogs, { taskId: action.taskId, line: action.line }),
      };
    case 'phase:start':
      return { ...state, currentPhase: action.phase };
    case 'build:complete':
      return { ...state, status: action.status, done: true };
    case 'error':
      return { ...state, error: action.message, done: true };
    default:
      return state;
  }
}

const initialState: AppState = {
  feature: '',
  status: 'planning',
  tasks: [],
  currentPhase: 1,
  workerLogs: [],
  error: null,
  done: false,
};

export function App({ factory, requirement, resumeMode, resumeFeatureId, retryBlocked, refineMode, planMode, askForApproval, interactive }: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, initialState);
  const hasStartedRef = useRef(false);
  const [pendingPlan, setPendingPlan] = useState<{ lines: string[]; prompt?: string; resolve: (decision: PlanDecision) => void } | null>(null);

  if (askForApproval && !factory.approvePlan) {
    factory.approvePlan = planState => new Promise(resolve => setPendingPlan({ lines: formatPlan(planState), resolve }));
  }
  if (interactive && !factory.confirmOverBudget) {
    factory.confirmOverBudget = message => new Promise(resolve => setPendingPlan({ lines: [message], prompt: 'Continue past the planned budget? y = continue, n = halt (resume later with --resume)', resolve: decision => resolve(decision === 'approve') }));
  }

  useInput((input, key) => {
    if (!pendingPlan) return;
    const answer = input.toLowerCase();
    if (answer === 'y') { pendingPlan.resolve('approve'); setPendingPlan(null); }
    else if (answer === 'n' || answer === 'q' || key.escape) { pendingPlan.resolve('abort'); setPendingPlan(null); }
  }, { isActive: Boolean(askForApproval || interactive) });

  const handleEvent = useCallback((event: FactoryEvent) => {
    switch (event.type) {
      case 'state:update':
        dispatch({ type: 'state:update', state: event.state });
        break;
      case 'worker:output':
        for (const line of normalizeWorkerOutput(event.line)) {
          dispatch({ type: 'worker:output', taskId: event.taskId, line });
        }
        break;
      case 'phase:start':
        dispatch({ type: 'phase:start', phase: event.phase });
        break;
      case 'task:auto-replan':
        dispatch({ type: 'worker:output', taskId: event.task_id, line: `Auto-replan (${event.reason}) → ${event.replacements.join(', ')}` });
        break;
      case 'task:auto-replan-failed':
        dispatch({ type: 'worker:output', taskId: event.task_id, line: `Auto-replan failed: ${event.error}` });
        break;
      case 'build:complete':
        dispatch({ type: 'build:complete', status: event.status, feature: event.feature });
        break;
    }
  }, []);

  useEffect(() => {
    factory.on('state:update', handleEvent);
    factory.on('worker:output', handleEvent);
    factory.on('phase:start', handleEvent);
    factory.on('task:auto-replan', handleEvent);
    factory.on('task:auto-replan-failed', handleEvent);
    factory.on('build:complete', handleEvent);

    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      const run = startFactoryRun(factory, requirement, { resumeMode, resumeFeatureId, retryBlocked, refineMode, planMode });
      run.catch(err => {
        dispatch({ type: 'error', message: err.message });
      });
    }

    return () => {
      factory.off('state:update', handleEvent);
      factory.off('worker:output', handleEvent);
      factory.off('phase:start', handleEvent);
      factory.off('task:auto-replan', handleEvent);
      factory.off('task:auto-replan-failed', handleEvent);
      factory.off('build:complete', handleEvent);
    };
  }, [factory, requirement, handleEvent, resumeMode, resumeFeatureId, retryBlocked, refineMode, planMode]);

  useEffect(() => {
    if (state.done) {
      const timer = setTimeout(() => exit(), 1000);
      return () => clearTimeout(timer);
    }
  }, [state.done, exit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Header feature={state.feature} status={state.status} />

      {state.tasks.length > 0 && (
        <>
          <PhaseProgress tasks={state.tasks} currentPhase={state.currentPhase} />
          <TaskList tasks={state.tasks} />
        </>
      )}

      {pendingPlan && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          {pendingPlan.lines.map((line, i) => <Text key={i}>{line}</Text>)}
          <Text bold color="yellow">{pendingPlan.prompt ?? 'Start this plan? y = start, n = keep it unstarted (change it with --refine)'}</Text>
        </Box>
      )}

      <WorkerOutput logs={state.workerLogs} />

      {state.error && (
        <Box marginTop={1}>
          <Text color="red" bold>Error: </Text>
          <Text color="red">{state.error}</Text>
        </Box>
      )}

      {state.done && (
        <Box marginTop={1}>
          <Text bold color={state.status === 'completed' ? 'green' : state.status === 'paused' || state.status === 'planned' ? 'yellow' : 'red'}>
            {state.status === 'paused' ? 'Build paused: finish the manual task(s) above, then softfactory --mark-done <id> --resume' : `Build ${state.status}!`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
