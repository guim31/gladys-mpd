// -----------------------------------------------------------------------------
// Repeated failures, logged once.
//
// A player that stays unreachable is tried again and again, Gladys may keep
// refusing a publication: each would write the same warning at every
// attempt. An issue log keeps, per key, whether the problem is ongoing: the
// first failure is a warning, the next ones go to debug, and the recovery is
// one info line. (From guim31/gladys-subsonic.)
// -----------------------------------------------------------------------------

/**
 * @param {{ debug: Function, info: Function, warn: Function }} logger
 */
export function createIssueLog(logger) {
  const ongoing = new Set();
  return {
    /**
     * Report a failure: a warning the first time, debug while it lasts.
     * @param {string} key what failed (one key per independent problem)
     * @param {string} message
     */
    fail(key, message) {
      if (ongoing.has(key)) {
        logger.debug(`${message} (still failing)`);
        return;
      }
      ongoing.add(key);
      logger.warn(message);
    },

    /**
     * Report a success: one info line when it ends an ongoing failure.
     * @param {string} key
     * @param {string} [message] said on recovery only
     * @returns {boolean} whether a failure was ongoing
     */
    ok(key, message) {
      const was = ongoing.delete(key);
      if (was && message) {
        logger.info(message);
      }
      return was;
    },

    /** @param {string} key */
    isFailing(key) {
      return ongoing.has(key);
    },
  };
}
