const isTTY = process.stdout.isTTY ?? false;

function wrap(code: number, text: string): string {
  return isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const c = {
  bold: (s: string) => wrap(1, s),
  dim: (s: string) => wrap(2, s),
  red: (s: string) => wrap(31, s),
  green: (s: string) => wrap(32, s),
  yellow: (s: string) => wrap(33, s),
  blue: (s: string) => wrap(34, s),
  cyan: (s: string) => wrap(36, s),
};

export function printHeader(title: string): void {
  console.log(`\n${c.bold(c.cyan(`▸ ${title}`))}`);
}

export function printPass(msg: string): void {
  console.log(`  ${c.green("✓")} ${msg}`);
}

export function printFail(msg: string): void {
  console.log(`  ${c.red("✗")} ${msg}`);
}

export function printWarn(msg: string): void {
  console.log(`  ${c.yellow("!")} ${msg}`);
}

export function printInfo(msg: string): void {
  console.log(`  ${c.dim("·")} ${msg}`);
}
