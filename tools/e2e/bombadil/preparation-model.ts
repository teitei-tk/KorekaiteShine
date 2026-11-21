import { requireValue } from './required.ts';
import type { components } from '@korekaite/api-contracts/http';
export type PreparationView<Material = string> = {
  epoch: number;
  markdown: Material;
  confirmed: boolean;
  pending: boolean;
  analyzeDisabled: boolean;
  themes: components['schemas']['MaterialTheme'][];
  selected: number | null;
};
export type AnalysisObservation<Material = string> = {
  body: Omit<components['schemas']['MaterialAnalysisRequest'], 'confirmed' | 'markdown'> & {
    confirmed: boolean;
    markdown: Material;
  };
  markdown: Material;
  confirmed: boolean;
  epoch: number;
  started: number;
  finished: number | null;
  response?: components['schemas']['SavedMaterialAnalysis'] | null;
};
export type PreparationObservation<Material = string> = {
  view: PreparationView<Material> | null;
  requests: AnalysisObservation<Material>[];
  edits: {
    before: PreparationView<Material>;
    after: PreparationView<Material>;
  }[];
};
function invalidMaterial(markdown: string): boolean {
  // Native仕様の実行環境でも使えるよう、DOMのTextEncoderには依存しない。
  const size = { bytes: 0 };
  for (const character of markdown) {
    const point = requireValue(character.codePointAt(0));
    size.bytes += point <= 0x7f ? 1 : point <= 0x7_ff ? 2 : point <= 0xff_ff ? 3 : 4;
  }
  return !markdown.trim() || size.bytes > 32_768;
}
export function preparationIssues(observation: PreparationObservation): string[] {
  const issues: string[] = [];
  if (
    observation.view &&
    (observation.view.pending ||
      !observation.view.confirmed ||
      invalidMaterial(observation.view.markdown)) !== observation.view.analyzeDisabled
  ) {
    issues.push('analysis-button-policy');
  }
  if (
    observation.requests.some(
      (request) =>
        !request.confirmed || !request.body.confirmed || request.body.markdown !== request.markdown,
    )
  ) {
    issues.push('unconfirmed-analysis');
  }
  if (observation.requests.some((request) => invalidMaterial(request.body.markdown))) {
    issues.push('invalid-analysis-material');
  }
  if (
    observation.requests.some((first, index) =>
      observation.requests.some(
        (second, other) =>
          index !== other &&
          first.epoch === second.epoch &&
          first.started <= second.started &&
          (first.finished === null || second.started < first.finished),
      ),
    )
  ) {
    issues.push('duplicate-analysis');
  }
  if (
    observation.edits.some(
      ({ before, after }) =>
        before.markdown !== after.markdown &&
        (after.confirmed || after.themes.length > 0 || after.selected !== null),
    )
  ) {
    issues.push('material-edit-reset');
  }
  const { view } = observation;
  if (
    view &&
    view.themes.length > 0 &&
    !observation.requests.some(
      (request) =>
        request.epoch === view.epoch &&
        request.body.markdown === view.markdown &&
        request.finished !== null &&
        request.response?.themes.length === view.themes.length &&
        request.response.themes.every((theme, index) => {
          const visible = requireValue(view.themes[index]);
          return (
            theme.title === visible.title &&
            theme.heading === visible.heading &&
            theme.excerpt === visible.excerpt
          );
        }),
    )
  ) {
    issues.push('stale-analysis');
  }
  return issues;
}
