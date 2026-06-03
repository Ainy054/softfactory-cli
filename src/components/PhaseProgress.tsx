import React from 'react';
import { Box, Text } from 'ink';
import { Task } from '../types.js';

interface PhaseProgressProps {
  tasks: Task[];
  currentPhase: number;
}

export function PhaseProgress({ tasks, currentPhase }: PhaseProgressProps) {
  const phases = [...new Set(tasks.map(t => t.phase))].sort((a, b) => a - b);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {phases.map(phase => {
        const phaseTasks = tasks.filter(t => t.phase === phase);
        const done = phaseTasks.filter(t => t.status === 'done').length;
        const total = phaseTasks.length;
        const active = phase === currentPhase;
        const allDone = done === total;

        const barWidth = 20;
        const filled = Math.round((done / total) * barWidth);
        const bar = '='.repeat(filled) + '-'.repeat(barWidth - filled);

        return (
          <Box key={phase}>
            <Text dimColor={!active}>
              {active ? '> ' : '  '}
              Phase {phase}: [{bar}] {done}/{total}
              {allDone ? ' done' : ''}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
