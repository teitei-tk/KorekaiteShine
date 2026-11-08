import {
  validateMaterialAnalysisRequest,
  validateMaterialAnalysisResult,
} from '@korekaite/api-contracts/http/materials-validators';
import type { components } from '@korekaite/api-contracts/http';

type MaterialInputValue =
  | string
  | number
  | boolean
  | null
  | MaterialInputValue[]
  | {
      [key: string]: MaterialInputValue;
    };

export interface MaterialAnalysisInput {
  markdown?: string;
  confirmed?: boolean;
  // 未検証の追加項目は受け取れるが、生成validatorで拒否する。
  [key: string]: MaterialInputValue | undefined;
}

export interface MaterialAnalysisCandidate {
  themes?: Partial<components['schemas']['MaterialTheme']>[] | null;
}

export interface MaterialAnalysisDependencies {
  analyze(markdown: string, signal: AbortSignal): Promise<MaterialAnalysisCandidate | null>;
}

export function readMaterialInput(input: MaterialAnalysisInput | null) {
  if (!validateMaterialAnalysisRequest(input)) {
    if (
      validateMaterialAnalysisRequest.errors?.some(
        (error) => error.instancePath === '/markdown' && error.keyword === 'maxLength',
      )
    ) {
      return { ok: false, code: 'MATERIAL_TOO_LARGE' } as const;
    }
    return { ok: false, code: 'INVALID_MATERIAL' } as const;
  }
  if (!input.markdown.trim()) {
    return { ok: false, code: 'INVALID_MATERIAL' } as const;
  }
  if (new TextEncoder().encode(input.markdown).byteLength > 32768) {
    return { ok: false, code: 'MATERIAL_TOO_LARGE' } as const;
  }
  return { ok: true, value: input } as const;
}

export async function analyzeMaterial(
  input: MaterialAnalysisInput | null,
  deps: MaterialAnalysisDependencies,
) {
  const checked = readMaterialInput(input);
  if (!checked.ok) {
    return checked;
  }
  const { markdown } = checked.value;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('材料分析の待機期限を超えました。'));
    }, 120_000);
  });
  let value: MaterialAnalysisCandidate | null;
  try {
    value = await Promise.race([deps.analyze(markdown, controller.signal), expired]);
  } catch {
    return { ok: false, code: 'AI_UNAVAILABLE' } as const;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (!validateMaterialAnalysisResult(value)) {
    return { ok: false, code: 'INVALID_AI_RESULT' } as const;
  }
  const headings = new Set<string>();
  const lines = markdown.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (atx) {
      headings.add(atx[1].trim());
    } else if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/u.test(line) && lines[index - 1].trim()) {
      headings.add(lines[index - 1].trim());
    }
  }
  if (headings.size === 0) {
    headings.add('本文');
  }
  const themes = new Set<string>();
  for (const theme of value.themes) {
    const key = JSON.stringify([theme.title, theme.heading, theme.excerpt]);
    if (!markdown.includes(theme.excerpt) || !headings.has(theme.heading) || themes.has(key)) {
      return { ok: false, code: 'INVALID_AI_RESULT' } as const;
    }
    themes.add(key);
  }
  return { ok: true, value } as const;
}
