import React from 'react';
import { Box, Text } from 'ink';
import { SOFTFACTORY_VERSION } from '../version.js';

interface HeaderProps {
  feature: string;
  status: string;
}

const statusColors: Record<string, string> = {
  planning: 'yellow',
  planned: 'blue',
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
        <Text dimColor> v{SOFTFACTORY_VERSION}</Text>
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
