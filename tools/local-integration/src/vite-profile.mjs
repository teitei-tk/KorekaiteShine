import { writeFileSync } from 'node:fs';

const now = () => Number(process.hrtime.bigint()) / 1e6;
const moduleHooks = new Set(['resolveId', 'load', 'transform']);
const hooks = [
  'config',
  'configEnvironment',
  'configResolved',
  'configureServer',
  'buildStart',
  'resolveId',
  'load',
  'transform',
  'applyToEnvironment',
];

export function summarizeViteSpans(spans, start, end) {
  const clipped = spans
    .filter((span) => span.start < end && span.end > start)
    .map((span) => ({
      name: span.name,
      hook: span.hook,
      category: span.category,
      start: Math.max(start, span.start),
      end: Math.min(end, span.end),
    }));
  const events = clipped
    .flatMap((span) => [
      { at: span.start, category: span.category, delta: 1 },
      { at: span.end, category: span.category, delta: -1 },
    ])
    .toSorted((left, right) => left.at - right.at);
  const counts = { plugin: 0, worker: 0, module: 0 };
  const result = {
    totalMs: end - start,
    pluginOnlyMs: 0,
    workerOnlyMs: 0,
    moduleOnlyMs: 0,
    workerAndModuleMs: 0,
    otherMs: 0,
  };
  const cursor = { at: start };
  for (const event of [...events, { at: end, category: 'plugin', delta: 0 }]) {
    const key =
      counts.worker > 0 && counts.module > 0
        ? 'workerAndModuleMs'
        : counts.worker > 0
          ? 'workerOnlyMs'
          : counts.module > 0
            ? 'moduleOnlyMs'
            : counts.plugin > 0
              ? 'pluginOnlyMs'
              : 'otherMs';
    result[key] += event.at - cursor.at;
    counts[event.category] += event.delta;
    cursor.at = event.at;
  }
  const groups = new Map();
  for (const span of clipped) {
    const key = `${span.name}:${span.hook}`;
    const group = groups.get(key) ?? {
      name: span.name,
      hook: span.hook,
      category: span.category,
      count: 0,
      inclusiveMs: 0,
      maxMs: 0,
    };
    const duration = span.end - span.start;
    group.count += 1;
    group.inclusiveMs += duration;
    group.maxMs = Math.max(group.maxMs, duration);
    groups.set(key, group);
  }
  return {
    ...result,
    hooks: [...groups.values()].toSorted((a, b) => b.inclusiveMs - a.inclusiveMs),
  };
}

export function createViteProfiler() {
  const spans = [];
  const seen = new WeakSet();
  const workers = new WeakSet();
  const state = { enabled: true, dropped: 0 };
  function wrap(name, hook, original, category = moduleHooks.has(hook) ? 'module' : 'plugin') {
    return function (...args) {
      if (!state.enabled) {
        return Reflect.apply(original, this, args);
      }
      const span = { name, hook, category, start: now(), end: undefined };
      if (spans.length < 100_000) {
        spans.push(span);
      } else {
        state.dropped += 1;
      }
      const finish = () => {
        span.end = now();
      };
      const adapt = (result) => {
        if (hook === 'configureServer' && typeof result === 'function') {
          return wrap(name, 'configureServer:post', result);
        }
        return result;
      };
      try {
        const result = Reflect.apply(original, this, args);
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).finally(finish).then(adapt);
        }
        finish();
        return adapt(result);
      } catch (error) {
        finish();
        throw error;
      }
    };
  }
  function instrument(plugin) {
    if (!plugin || seen.has(plugin)) {
      return plugin;
    }
    seen.add(plugin);
    for (const hook of hooks) {
      const original = plugin[hook];
      if (typeof original === 'function') {
        plugin[hook] = wrap(plugin.name, hook, original);
      } else if (original && typeof original.handler === 'function') {
        plugin[hook] = { ...original, handler: wrap(plugin.name, hook, original.handler) };
      }
    }
    return plugin;
  }
  function instrumentWorker(environment) {
    if (workers.has(environment)) {
      return;
    }
    workers.add(environment);
    if (typeof environment.initRunner === 'function') {
      const original = environment.initRunner;
      environment.initRunner = wrap(
        environment.name,
        'initRunner',
        function (...args) {
          const [miniflare] = args;
          const prototype = Object.getPrototypeOf(miniflare);
          if (!workers.has(prototype)) {
            workers.add(prototype);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'ready');
            if (!descriptor?.get || !descriptor.configurable) {
              throw new Error('Miniflare.readyの計測点が見つかりません。');
            }
            Object.defineProperty(prototype, 'ready', {
              ...descriptor,
              get: wrap('miniflare', 'ready', descriptor.get, 'worker'),
            });
            for (const method of ['setOptions', 'dispatchFetch']) {
              if (typeof prototype[method] === 'function') {
                prototype[method] = wrap('miniflare', method, prototype[method], 'worker');
              }
            }
          }
          return Reflect.apply(original, this, args);
        },
        'worker',
      );
    }
    for (const method of ['fetchWorkerExportTypes', 'fetchModule']) {
      if (typeof environment[method] === 'function') {
        environment[method] = wrap(
          environment.name,
          method,
          environment[method],
          method === 'fetchModule' ? 'module' : 'worker',
        );
      }
    }
    for (const plugin of environment.plugins) {
      instrument(plugin);
    }
    const optimizer = environment.depsOptimizer;
    if (optimizer && !workers.has(optimizer)) {
      workers.add(optimizer);
      for (const method of ['init', 'run']) {
        if (typeof optimizer[method] === 'function') {
          optimizer[method] = wrap(environment.name, `depsOptimizer:${method}`, optimizer[method]);
        }
      }
    }
  }
  return {
    instrument,
    instrumentEnvironment: instrumentWorker,
    plugin: {
      name: 'korekaite-startup-profile',
      enforce: 'pre',
      configResolved: {
        order: 'pre',
        handler(config) {
          for (const plugin of config.plugins) {
            instrument(plugin);
          }
        },
      },
      configureServer: {
        order: 'pre',
        handler(server) {
          for (const environment of Object.values(server.environments)) {
            instrumentWorker(environment);
          }
        },
      },
    },
    snapshot(start, end) {
      return {
        ...summarizeViteSpans(
          spans.map((span) => ({ ...span, end: span.end ?? end })),
          start,
          end,
        ),
        dropped: state.dropped,
        pending: spans.filter((span) => span.end === undefined).length,
      };
    },
    stop() {
      state.enabled = false;
    },
  };
}

export async function profileVitePlugins(options, outputPath) {
  const profiler = createViteProfiler();
  async function resolve(option) {
    const value = await option;
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => resolve(item)));
    }
    return value ? profiler.instrument(value) : value;
  }
  const listener = (message) => {
    if (message?.type !== 'vite-startup-snapshot') {
      return;
    }
    const { start, url, end } = message;
    if (![start, url, end].every((item) => Number.isFinite(item)) || start > url || url > end) {
      throw new Error('Vite計測区間が不正です。');
    }
    profiler.stop();
    writeFileSync(
      outputPath,
      JSON.stringify({ url: profiler.snapshot(start, url), http: profiler.snapshot(url, end) }),
    );
    process.send('vite-startup-snapshot-saved');
    process.off('message', listener);
  };
  process.on('message', listener);
  return [profiler.plugin, await resolve(options)];
}
