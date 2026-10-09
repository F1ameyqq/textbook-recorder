const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, copy(value[name])]));

/** Keep task identity and recovery blockers; large evidence stays in local files. */
export function summarizeRecorderStatus(status) {
  if (!object(status)) throw new Error('执行器状态不是对象');
  const summary = fields(status, ['bookId', 'sessionPath', 'connection', 'authConfigured', 'connectionCount', 'reconnectBlocked', 'tabCleanup', 'writeBlocked', 'error', 'taskNotRetried', 'closed', 'started', 'id', 'stopRequested', 'rejected']);
  summary.pending = status.pending ? fields(status.pending, ['id', 'action']) : null;
  if (status.pauseControl) summary.pauseControl = fields(status.pauseControl, ['schemaVersion', 'generation', 'paused']);
  if (status.continuationFence) summary.continuationFence = fields(status.continuationFence, ['schemaVersion', 'previousTerminalId', 'pauseGeneration', 'paused']);
  if (status.reconnect) summary.reconnect = fields(status.reconnect, ['automaticAttempts', 'maximum', 'limited']);
  if (status.recovery) summary.recovery = fields(status.recovery, ['required', 'taskId', 'pendingPath', 'instruction']);
  const job = status.pending
    ? status.remote?.job?.id === status.pending.id ? status.remote.job : null
    : status.last ?? status.remote?.job ?? status.job;
  if (job) {
    summary.job = fields(job, ['id', 'action', 'running', 'terminal', 'phase', 'phaseTaskId', 'adapterPhase', 'error', 'evidenceError', 'preflightPath', 'stopRequested']);
    if (job.progress) summary.job.progress = fields(job.progress, ['status', 'completed', 'total', 'verifiedReadbacks', 'downloaded', 'skipped', 'requestedPages', 'systemPage', 'paused']);
    if (job.result) {
      summary.job.result = fields(job.result, ['bookId', 'taskId', 'stateStatus', 'stopReason', 'counts', 'uncertain', 'writePerformed', 'connected', 'recordCount', 'recordId', 'status', 'scopes', 'records', 'downloaded', 'skipped', 'requestedPages', 'paused', 'manifestPath', 'statePath', 'recordsPath', 'inventoryPath', 'indexPath', 'readbackPath', 'readbackEvidence', 'sectionEvidence', 'screenshotPath', 'outputDirectory']);
      // `records` is an inventory count, never the exported records themselves.
      if (typeof summary.job.result.records !== 'number') delete summary.job.result.records;
      if (job.result.comparison) summary.job.result.comparison = fields(job.result.comparison, ['ok', 'errors']);
      if (job.result.recovery) summary.job.result.recovery = fields(job.result.recovery, ['outcome', 'writeUnlocked', 'taskId', 'bookId', 'recordId', 'evidencePath', 'errors']);
      if (job.result.pendingWrite) summary.job.result.pendingWrite = {
        ...fields(job.result.pendingWrite, ['status', 'phase', 'evidencePath']),
        task: fields(job.result.pendingWrite.task, ['id']),
      };
    }
  }
  return summary;
}
