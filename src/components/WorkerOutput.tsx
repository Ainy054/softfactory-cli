import React from 'react';
import { Box, Text } from 'ink';

interface WorkerOutputProps {
  logs: Array<{ taskId: string; line: string }>;
  maxLines?: number;
}

export function WorkerOutput({ logs, maxLines = 8 }: WorkerOutputProps) {
  const visible = logs.slice(-maxLines);

  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold dimColor>Worker Output:</Text>
      {visible.map((entry, i) => (
        <Box key={i}>
          <Text color="cyan">[{entry.taskId}] </Text>
          <Text wrap="truncate">{entry.line}</Text>
        </Box>
      ))}
    </Box>
  );
}
