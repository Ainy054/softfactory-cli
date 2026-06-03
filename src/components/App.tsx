import React, { useReducer, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Factory } from '../Factory.js';
import { Task, FactoryState, FactoryEvent } from '../types.js';
import { Header } from './Header.js';
import { PhaseProgress } from './PhaseProgress.js';
import { TaskList } from './TaskList.js';
import { WorkerOutput } from './WorkerOutput.js';

interface AppProps {
  factory: Factory;
  requirement: string;
  resumeMode?: boolean;
  resumeFeatureId?: string;
  refineMode?: boolean;
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
        workerLogs: [...state.workerLogs, { taskId: action.taskId, line: action.line }],
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

export function App({ factory, requirement, resumeMode, resumeFeatureId, refineMode }: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, initialState);

  const handleEvent = useCallback((event: FactoryEvent) => {
    switch (event.type) {
      case 'state:update':
        dispatch({ type: 'state:update', state: event.state });
        break;
      case 'worker:output':
        dispatch({ type: 'worker:output', taskId: event.taskId, line: event.line });
        break;
      case 'phase:start':
        dispatch({ type: 'phase:start', phase: event.phase });
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
    factory.on('build:complete', handleEvent);

    const run = resumeMode
      ? factory.resume(resumeFeatureId)
      : refineMode
        ? factory.refine(requirement)
        : factory.build(requirement);
    run.catch(err => {
      dispatch({ type: 'error', message: err.message });
    });

    return () => {
      factory.removeAllListeners();
    };
  }, [factory, requirement, handleEvent]);

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

      <WorkerOutput logs={state.workerLogs} />

      {state.error && (
        <Box marginTop={1}>
          <Text color="red" bold>Error: </Text>
          <Text color="red">{state.error}</Text>
        </Box>
      )}

      {state.done && (
        <Box marginTop={1}>
          <Text bold color={state.status === 'completed' ? 'green' : 'red'}>
            Build {state.status}!
          </Text>
        </Box>
      )}
    </Box>
  );
}
