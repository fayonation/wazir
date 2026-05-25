import type { RiskPattern } from "@wazir/protocol";

export interface CompiledPattern {
  name: string;
  regex: RegExp;
  label: string;
}

export interface RiskClassification {
  risky: boolean;
  pattern?: CompiledPattern;
}

export function compilePatterns(patterns: RiskPattern[]): CompiledPattern[] {
  return patterns.map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex),
    label: p.label,
  }));
}

export function classify(command: string, patterns: CompiledPattern[]): RiskClassification {
  for (const p of patterns) {
    if (p.regex.test(command)) {
      return { risky: true, pattern: p };
    }
  }
  return { risky: false };
}
