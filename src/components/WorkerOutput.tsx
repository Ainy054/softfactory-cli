import React from 'react';
import { Box, Text } from 'ink';

interface WorkerOutputProps {
  logs: Array<{ taskId: string; line: string }>;
  maxLines?: number;
}

export function WorkerOutput({ logs, maxLines = 10 }: WorkerOutputProps) {
  const visible = logs.slice(-maxLines);

  if (visible.length === 0) return null;

  const getLineColor = (line: string): string => {
    if (line.startsWith('⟳') || line.startsWith('▶')) return 'magenta';
    if (line.includes('PASSED') || line.startsWith('↳ Writing') || line.startsWith('[Local Worker] Wrote') || line.includes('Patched')) return 'green';
    if (line.includes('FAILED') || line.includes('Error') || line.startsWith('[stderr]')) return 'red';
    if (line.startsWith('Generating') || line.startsWith('Running') || line.startsWith('Ingesting') || line.includes('elapsed')) return 'yellow';
    if (line.startsWith('Committed') || line.startsWith('Verifier') || line.startsWith('[Cloud Worker]') || line.startsWith('[Local Worker]')) return 'cyan';
    return 'white';
  };

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold dimColor>Worker Output:</Text>
      {visible.map((entry, i) => (
        <Box key={i}>
          <Text color="cyan">[{entry.taskId}] </Text>
          <Text color={getLineColor(entry.line)} wrap="truncate">{entry.line}</Text>
        </Box>
      ))}
    </Box>
  );
}
