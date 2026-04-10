export function hasCompleteSigil(text: string): boolean {
  return /^\s*<COMPLETE>\s*$/m.test(text);
}
