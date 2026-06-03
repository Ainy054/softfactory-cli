import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  feature: string;
  status: string;
}

const statusColors: Record<string, string> = {
  planning: 'yellow',
  active: 'cyan',
  completed: 'green',
  failed: 'red',
};

export function Header({ feature, status }: HeaderProps) {
  const color = statusColors[status] || 'white';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">{'>>> '}</Text>
        <Text bold>SoftFactory</Text>
        <Text dimColor> v2.0</Text>
      </Box>
      <Box>
        <Text dimColor>Feature: </Text>
        <Text bold>{feature || 'Initializing...'}</Text>
        <Text> </Text>
        <Text color={color}>[{status}]</Text>
      </Box>
    </Box>
  );
}
