import color from 'picocolors';

export function printHeader(): void {
  const lines = [
    '╔══════════════════════════════════════════════╗',
    '║       AgentPay — Interactive Setup           ║',
    '║   Trusted Payment Infrastructure for Agents  ║',
    '╚══════════════════════════════════════════════╝',
  ];
  console.log();
  for (const line of lines) {
    console.log(color.cyan(line));
  }
  console.log();
}
