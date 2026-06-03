import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Task } from '../types.js';

interface TaskListProps {
  tasks: Task[];
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  pending: { icon: '.', color: 'gray' },
  active: { icon: '*', color: 'yellow' },
  done: { icon: 'v', color: 'green' },
  failed: { icon: 'x', color: 'red' },
  rejected: { icon: '!', color: 'red' },
};

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

function SpinnerIcon() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return <Text color="yellow">{SPINNER_FRAMES[frame]}</Text>;
}

export function TaskList({ tasks }: TaskListProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold dimColor>Tasks:</Text>
      {tasks.map(task => {
        const { icon, color } = STATUS_ICONS[task.status] || STATUS_ICONS.pending;
        const retryInfo = task.attempts > 0 ? ` (attempt ${task.attempts + 1}/3)` : '';

        return (
          <Box key={task.id}>
            <Text>  </Text>
            {task.status === 'active' ? (
              <SpinnerIcon />
            ) : (
              <Text color={color}>{icon}</Text>
            )}
            <Text> </Text>
            <Text dimColor>{task.id}</Text>
            <Text> </Text>
            <Text color={task.status === 'done' ? 'green' : task.status === 'failed' ? 'red' : 'white'}>
              {task.title}
            </Text>
            <Text dimColor> [{task.agent_role}]</Text>
            {retryInfo && <Text color="yellow">{retryInfo}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
