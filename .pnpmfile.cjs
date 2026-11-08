module.exports = {
  hooks: {
    readPackage(pkg) {
      // この生成器は5系のCompiler APIを使う。ツール側の7系とは解決を分離する。
      if (pkg.name === 'openapi-typescript' && pkg.version === '7.13.0') {
        delete pkg.peerDependencies.typescript;
        pkg.dependencies.typescript = '5.9.3';
      }
      return pkg;
    },
  },
};
