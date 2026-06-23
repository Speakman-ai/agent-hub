#!/usr/bin/env node
/**
 * Add explicit `any` to untyped parameters and fix common strict-mode inference gaps.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'scripts') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

function addAnyToParam(param) {
  if (param.type || param.dotDotDotToken) return param;
  return ts.factory.updateParameterDeclaration(
    param,
    param.modifiers,
    param.dotDotDotToken,
    param.name,
    param.questionToken,
    ts.factory.createTypeReferenceNode('any'),
    param.initializer,
  );
}

function patchFunctionLike(node) {
  const params = node.parameters.map((p) => addAnyToParam(p));
  if (params.every((p, i) => p === node.parameters[i])) return node;
  if (ts.isFunctionDeclaration(node)) {
    return ts.factory.updateFunctionDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      params,
      node.type,
      node.body,
    );
  }
  if (ts.isFunctionExpression(node)) {
    return ts.factory.updateFunctionExpression(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      params,
      node.type,
      node.body,
    );
  }
  if (ts.isArrowFunction(node)) {
    return ts.factory.updateArrowFunction(
      node,
      node.modifiers,
      node.typeParameters,
      params,
      node.type,
      node.equalsGreaterThanToken,
      node.body,
    );
  }
  if (ts.isMethodDeclaration(node)) {
    return ts.factory.updateMethodDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      params,
      node.type,
      node.body,
    );
  }
  return node;
}

function transformSource(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const transformer = (context) => {
    const visit = (node) => {
      let next = ts.visitEachChild(node, visit, context);

      if (
        ts.isFunctionDeclaration(next) ||
        ts.isFunctionExpression(next) ||
        ts.isArrowFunction(next) ||
        ts.isMethodDeclaration(next)
      ) {
        next = patchFunctionLike(next);
      }

      if (ts.isCatchClause(next) && next.variableDeclaration && ts.isIdentifier(next.variableDeclaration.name)) {
        const v = next.variableDeclaration;
        if (!v.type) {
          next = ts.factory.updateCatchClause(
            next,
            ts.factory.updateVariableDeclaration(
              v,
              v.name,
              v.exclamationToken,
              ts.factory.createTypeReferenceNode('any'),
              v.initializer,
            ),
            next.block,
          );
        }
      }

      if (ts.isCallExpression(next)) {
        const expr = next.expression;
        if (ts.isIdentifier(expr) && expr.text === 'createContext' && !next.typeArguments?.length) {
          next = ts.factory.updateCallExpression(
            next,
            expr,
            ts.factory.createNodeArray([ts.factory.createTypeReferenceNode('any')]),
            next.arguments,
          );
        }
        if (ts.isIdentifier(expr)) {
          const name = expr.text;
          if (
            (name === 'useState' || name === 'useRef' || name === 'useReducer') &&
            !next.typeArguments?.length &&
            next.arguments.length >= 1
          ) {
            const arg0 = next.arguments[0];
            let typeArg = null;
            if (arg0.kind === ts.SyntaxKind.NullKeyword) typeArg = ts.factory.createTypeReferenceNode('any');
            if (ts.isArrayLiteralExpression(arg0) && arg0.elements.length === 0) {
              typeArg =
                name === 'useState'
                  ? ts.factory.createArrayTypeNode(ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword))
                  : ts.factory.createTypeReferenceNode('any');
            }
            if (ts.isObjectLiteralExpression(arg0) && arg0.properties.length === 0) {
              typeArg = ts.factory.createTypeReferenceNode('any');
            }
            if (
              ts.isNewExpression(arg0) &&
              ts.isIdentifier(arg0.expression) &&
              arg0.expression.text === 'Set'
            ) {
              typeArg = ts.factory.createTypeReferenceNode('any');
            }
            if (typeArg) {
              next = ts.factory.updateCallExpression(
                next,
                expr,
                ts.factory.createNodeArray([typeArg]),
                next.arguments,
              );
            }
          }
        }
      }

      return next;
    };
    return (node) => ts.visitNode(node, visit);
  };

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LF });
  const out = printer.printFile(result.transformed[0]);
  result.dispose();
  return out;
}

function applyTextFixes(text) {
  return text
    .replace(/\buseState\s*\(\s*new Set\(\s*\)\s*\)/g, 'useState<any>(new Set())')
    .replace(/\buseState\s*\(\s*new Map\(\s*\)\s*\)/g, 'useState<any>(new Map())')
    .replace(/\buseRef\s*\(\s*\[\s*\]\s*\)/g, 'useRef<any>([])')
    .replace(/\buseRef\s*\(\s*\{\s*\}\s*\)/g, 'useRef<any>({})')
    .replace(/\buseRef\s*\(\s*new Set\(\s*\)\s*\)/g, 'useRef<any>(new Set())')
    .replace(/\buseRef\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g, 'useRef<any>(() => {})');
}

const files = [...walk(ROOT), path.join(ROOT, 'App.tsx')].filter((f) => fs.existsSync(f));
let changed = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const original = fs.readFileSync(file, 'utf8');
  let next = transformSource(original, rel);
  next = applyTextFixes(next);
  if (next !== original) {
    fs.writeFileSync(file, next);
    changed++;
  }
}

console.log(`Updated ${changed} / ${files.length} files`);
