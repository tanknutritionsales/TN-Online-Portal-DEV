const deferred = () => Object.assign(new Error("Email is queued for the next available sending slot."), { emailDeferred: true, retryAfterSeconds: 2 });
export function createEmailCapacity({ limiter, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return async function reserve({ wait = false, deadline = Infinity } = {}) {
    const stop = Math.min(deadline - 6000, now() + 4000);
    for (;;) {
      if (now() >= stop) throw deferred();
      const claim = await limiter.check({ key: "transactional-mail", bucket: "email-provider", limit: 1, windowMs: 250 });
      if (claim.allowed) return;
      if (!wait || now() >= stop) throw deferred();
      await sleep(Math.max(25, Math.min(300, claim.resetAt - now() + 20, stop - now())));
    }
  };
}
