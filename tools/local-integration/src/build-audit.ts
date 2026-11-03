import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export interface BuildAudit {
  environment: string;
  outputDirectory: string;
  modules: { id: string; imports: string[]; dynamicImports: string[]; isEntry: boolean }[];
  outputs: { fileName: string; sha256: string; modules: string[] }[];
}

/** 配信物の外に、実際に読み込まれたモジュールと出力の対応を残す。 */
export function buildAudit(directory: string): Plugin {
  return {
    name: 'korekaite-build-audit',
    apply: 'build',
    enforce: 'post',
    async writeBundle(options, bundle) {
      const outputDirectory = resolve(this.environment.config.root, options.dir ?? 'dist');
      const modules: BuildAudit['modules'] = [];
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (!info) throw new Error(`モジュール情報がありません: ${id}`);
        modules.push({
          id,
          imports: info.importedIds,
          dynamicImports: info.dynamicallyImportedIds,
          isEntry: info.isEntry,
        });
      }
      const outputs: BuildAudit['outputs'] = [];
      for (const output of Object.values(bundle)) {
        const bytes = await readFile(join(outputDirectory, output.fileName));
        outputs.push({
          fileName: output.fileName,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          modules: output.type === 'chunk' ? Object.keys(output.modules) : [],
        });
      }
      const audit: BuildAudit = {
        environment: this.environment.name,
        outputDirectory,
        modules,
        outputs,
      };
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${audit.environment}.json`), JSON.stringify(audit, null, 2));
    },
  };
}
