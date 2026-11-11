function propertyName(member) {
  return member.computed ? member.property.value : member.property.name;
}

function isGlobalObjectConstructor(node, sourceCode) {
  if (node.type === 'Identifier') {
    return node.name === 'Object' && sourceCode.isGlobalReference(node);
  }
  return (
    node.type === 'MemberExpression' &&
    propertyName(node) === 'Object' &&
    node.object.type === 'Identifier' &&
    node.object.name === 'globalThis' &&
    sourceCode.isGlobalReference(node.object)
  );
}

export default {
  meta: { name: 'immutable' },
  rules: {
    'no-let': {
      create(context) {
        return {
          VariableDeclaration(node) {
            if (node.kind === 'let') {
              context.report({ node, message: 'letによる変数宣言は禁止です。' });
            }
          },
        };
      },
    },
    'no-param-reassign': {
      create(context) {
        function checkParameters(node) {
          for (const variable of context.sourceCode.getDeclaredVariables(node)) {
            if (variable.defs.some((definition) => definition.type === 'Parameter')) {
              for (const reference of variable.references) {
                if (reference.isWrite() && !reference.init) {
                  context.report({
                    node: reference.identifier,
                    message: '引数への再代入は禁止です。',
                  });
                }
              }
            }
          }
        }
        return {
          FunctionDeclaration: checkParameters,
          FunctionExpression: checkParameters,
          ArrowFunctionExpression: checkParameters,
        };
      },
    },
    'no-object-assign': {
      create(context) {
        return {
          MemberExpression(node) {
            if (
              propertyName(node) === 'assign' &&
              isGlobalObjectConstructor(node.object, context.sourceCode)
            ) {
              context.report({ node, message: 'Object.assignの使用は禁止です。' });
            }
          },
        };
      },
    },
  },
};
