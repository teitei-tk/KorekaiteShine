import type { JsonValue } from '@korekaite/api-contracts/json';
import { requireValue } from './required.ts';
import { always } from '@antithesishq/bombadil';
import type { Cell } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
import type { ActionTemplate } from '@antithesishq/bombadil/browser';
import type { ExplorationFixtures } from './fixtures.ts';
import {
  installPreparationObserver,
  readPreparationSnapshot,
  restorePreparationSnapshot,
} from './observe.ts';
import { performPreparationAction } from './preparation-actions.ts';
import { preparationIssues } from './preparation-model.ts';
import { preparationMaterials } from './preparation-materials.ts';
export function createSpecification(fixtures: ExplorationFixtures) {
  const observation = extract(readPreparationSnapshot);
  const coverage: Cell<{ reached: string[]; delay: string | null } | null> = extract(
    ({ window }) => {
      const value = JSON.parse(
        window.sessionStorage.getItem('bombadil-preparation-coverage') ?? '{"reached":[]}',
      ) as JsonValue;
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Array.isArray(value.reached)
      ) {
        throw new Error('到達記録が不正です。');
      }
      const reached = value.reached.map((marker) => {
        if (typeof marker !== 'string') {
          throw new TypeError('到達記録が文字列ではありません。');
        }
        return marker;
      });
      return { reached, delay: window.sessionStorage.getItem('bombadil-preparation-delay') };
    },
  );
  const initialize = registerCustomAction<[string]>(
    'preparation-observe',
    installPreparationObserver,
  );
  const step = registerCustomAction('preparation-operate', performPreparationAction);
  const material = preparationMaterials.normal;
  const { edited } = preparationMaterials;
  const explore = actions(() => {
    const snapshot = restorePreparationSnapshot(observation.current);
    if (!snapshot) {
      return [initialize(requireValue(fixtures.interviews[0]).theme)];
    }
    const { view } = snapshot;
    if (!view) {
      return [step('back', '')];
    }
    if (coverage.current?.delay === 'held') {
      return [step('open', requireValue(fixtures.interviews[0]).theme)];
    }
    if (coverage.current?.delay === 'returned') {
      return [step('release-analysis', '')];
    }
    if (view.pending) {
      return [step('wait', '')];
    }
    const reached = coverage.current?.reached ?? [];
    if (!reached.includes('analyzed')) {
      if (view.markdown !== material) {
        return [step('edit', material)];
      }
      return [step(view.confirmed ? 'analyze' : 'confirm', '')];
    }
    if (!reached.includes('edited-after-confirmation')) {
      if (view.themes.length > 0 && view.selected === null) {
        return [step('select', '')];
      }
      return [step(view.confirmed ? 'edit' : 'confirm', edited)];
    }
    if (!reached.includes('blocked-unconfirmed')) {
      return [step(view.confirmed ? 'confirm' : 'blocked', '')];
    }
    if (!reached.includes('delayed-analysis-isolated')) {
      if (view.markdown !== edited) {
        return [step('edit', edited)];
      }
      return [step(view.confirmed ? 'hold-analyze' : 'confirm', '')];
    }
    const choices: [number, ActionTemplate][] = [
      [8, step('edit', material)],
      [6, step('edit', edited)],
      [1, step('edit', preparationMaterials.whitespace)],
      [1, step('edit', preparationMaterials.atLimit)],
      [1, step('edit', preparationMaterials.overLimit)],
      [3, step('confirm', '')],
      [1, step('blocked', '')],
      [2, step('open', requireValue(fixtures.interviews[0]).theme)],
    ];
    if (!view.analyzeDisabled) {
      choices.push([4, step('analyze', '')]);
    }
    if (view.themes.length > 0) {
      choices.push([2, step('select', '')]);
    }
    return {
      branches: choices.map(
        ([weight, value]) =>
          [weight, { value }] as [
            number,
            {
              value: ActionTemplate;
            },
          ],
      ),
    };
  });
  const invariant = always(() => {
    const snapshot = restorePreparationSnapshot(observation.current);
    const reached = coverage.current?.reached ?? [];
    return (
      (!snapshot ||
        (snapshot.integrityErrors.length === 0 && preparationIssues(snapshot).length === 0)) &&
      reached.every((marker) =>
        [
          'analyzed',
          'edited-after-confirmation',
          'blocked-unconfirmed',
          'delayed-analysis-isolated',
        ].includes(marker),
      )
    );
  });
  return { explore, invariant };
}
