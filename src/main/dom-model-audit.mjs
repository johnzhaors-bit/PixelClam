import fs from 'node:fs/promises';
import path from 'node:path';
import {
  COMPONENT_RESULT_TEMPLATE,
  auditComponent,
  normalizeComponentResult
} from './component-audit.mjs';

export const RESULT_TEMPLATE = COMPONENT_RESULT_TEMPLATE;
export const normalizeDomAuditResult = (value, componentFamily) =>
  normalizeComponentResult(value, componentFamily, 'dom');

export async function auditDomSnapshot(options) {
  const output = await auditComponent({
    mode: 'dom',
    evidencePath: options.snapshotPath,
    standardPath: options.standardPath,
    componentFamily: options.componentFamily,
    config: options.config,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress
  });
  const resultPath = path.join(
    path.dirname(options.snapshotPath),
    `${options.componentFamily || 'button'}-audit-result.json`
  );
  await fs.writeFile(resultPath, JSON.stringify(output.result, null, 2), 'utf8');
  return { ...output, resultPath };
}
