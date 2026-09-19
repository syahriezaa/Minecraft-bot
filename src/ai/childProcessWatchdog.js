const { WorkProgress } = require('./workProgress');

function signalChildProcess(child, signal) {
  if (child?._codexProcessGroup === true && process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try { process.kill(-child.pid, signal); return true; } catch {}
  }
  try { return child?.kill?.(signal) || false; } catch { return false; }
}

function terminateChildProcess(child, graceMs = 5000, signal = 'SIGTERM') {
  signalChildProcess(child, signal);
  const timer = setTimeout(() => {
    if (child?._codexProcessGroup === true || (child?.exitCode === null && child?.signalCode === null)) {
      signalChildProcess(child, 'SIGKILL');
    }
  }, Math.max(250, Number(graceMs) || 5000));
  timer.unref?.();
  return timer;
}

class ChildProcessWatchdog {
  constructor(child, { timeoutMs, intervalMs = 5000, terminateGraceMs = 5000,
    now = Date.now, onStall = () => {} } = {}) {
    if (!child || typeof child.kill !== 'function') throw new TypeError('Watchdog membutuhkan child process.');
    this.child = child;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 10 * 60 * 1000);
    this.terminateGraceMs = Math.max(250, Number(terminateGraceMs) || 5000);
    this.now = now;
    this.onStall = onStall;
    this.lastProgressAt = now();
    this.progress = new WorkProgress();
    this.stalled = false;
    this.closed = false;
    this.killTimer = null;
    this.onExit = () => this.close({ preserveGroupTermination: this.stalled && child._codexProcessGroup === true });
    child.on?.('exit', this.onExit);
    this.timer = setInterval(() => this._check(), Math.max(250, Number(intervalMs) || 5000));
    this.timer.unref?.();
  }

  beginSession(source, session) {
    if (this.closed || this.stalled) return false;
    return this.progress.beginSession(source, session);
  }

  acceptsSession(source, session) {
    return this.progress.acceptsSession(source, session);
  }

  beat(details, source = '') {
    if (this.closed || this.stalled) return false;
    if (!this.progress.observe(details, source)) return false;
    this.lastProgressAt = this.now();
    return true;
  }

  _check() {
    if (this.closed || this.stalled || this.now() - this.lastProgressAt < this.timeoutMs) return;
    this.stalled = true;
    const silentForMs = this.now() - this.lastProgressAt;
    try { this.onStall({ silentForMs }); } catch {}
    signalChildProcess(this.child, 'SIGTERM');
    this.killTimer = setTimeout(() => {
      if (!this.closed || this.child._codexProcessGroup === true) {
        if (this.child._codexProcessGroup === true ||
          (this.child.exitCode === null && this.child.signalCode === null)) signalChildProcess(this.child, 'SIGKILL');
      }
      this.killTimer = null;
    }, this.terminateGraceMs);
    this.killTimer.unref?.();
  }

  close({ preserveGroupTermination = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.killTimer && !preserveGroupTermination) clearTimeout(this.killTimer);
    this.child.removeListener?.('exit', this.onExit);
  }
}

module.exports = { ChildProcessWatchdog, signalChildProcess, terminateChildProcess };
