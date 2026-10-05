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
  blocked: { icon: '#', color: 'magenta' },
  manual: { icon: '?', color: 'yellow' },
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
        let statusBadge: React.ReactNode = null;
        if (task.status === 'active') {
          if (task.attempts > 0) {
            statusBadge = (
              <Text color="yellow"> ⟳ [Iteration {task.attempts + 1} • Escalation {task.escalation_level || 0} • {task.model || 'worker'}]</Text>
            );
          } else {
            statusBadge = (
              <Text color="cyan"> ▶ [Running • {task.model || 'worker'}]</Text>
            );
          }
        } else if (task.status === 'done') {
          statusBadge = <Text color="green"> [Merged]</Text>;
        } else if (task.status === 'failed') {
          statusBadge = <Text color="red"> [Failed after {task.attempts} iterations]</Text>;
        } else if (task.status === 'blocked') {
          statusBadge = <Text color="magenta"> [Blocked{task.replan_reason ? ` • ${task.replan_reason}` : ''}]</Text>;
        } else if (task.status === 'manual') {
          statusBadge = <Text color="yellow"> [Waiting on {task.executor} • --mark-done {task.id}]</Text>;
        }

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
            {statusBadge}
          </Box>
        );
      })}
    </Box>
  );
}
