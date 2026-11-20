/**
 * Coalescing one-frame scheduler for the canvas preview.
 *
 * The v0.36–v0.40 builds had two competing flags (`previewPending` and a
 * `previewRun` slot) and the filter path set one flag before routing through a
 * function that returned early on that same flag — so the first slider touch
 * deadlocked the whole preview system and nothing ever rendered. One owner,
 * one flag, and a `flush()` for tests.
 */
export interface PreviewScheduler {
  /** replace the pending job and make sure exactly one frame is scheduled */
  queue(run: () => void): void;
  /** run the pending job now (tests, or a synchronous path that must repaint) */
  flush(): void;
  /** drop the pending job without running it (the tab changed under it) */
  cancel(): void;
  /** true while a frame is scheduled */
  readonly pending: boolean;
  /** number of jobs that actually ran — the anti-regression counter */
  readonly runs: number;
}

export function createPreviewScheduler(requestFrame: (cb: () => void) => void): PreviewScheduler {
  let queued = false;
  let job: (() => void) | null = null;
  let runs = 0;
  const flush = (): void => {
    queued = false;
    const pendingJob = job;
    job = null;
    if (!pendingJob) return;
    runs++;
    pendingJob();
  };
  return {
    queue(run: () => void): void {
      job = run;
      if (queued) return;
      queued = true;
      requestFrame(flush);
    },
    cancel(): void {
      // The frame still fires (it is already scheduled); it just finds no job.
      job = null;
    },
    flush,
    get pending(): boolean { return queued; },
    get runs(): number { return runs; },
  };
}
