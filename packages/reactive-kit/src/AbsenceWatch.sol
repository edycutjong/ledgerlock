// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title AbsenceWatch
/// @notice "Expected event + timeout" state for reactive contracts that act on something NOT happening:
///         an owner going silent, an oracle feed (canary) going stale. Timestamps only, never block counts
///         (Reactive and origin chains run at different block times).
/// @dev The check runs on a CRON tick, so its effective resolution is the tick period, not `maxGap`.
///      `arm` resets `lastAt` to the arming time so a watch armed late is not instantly stale.
library AbsenceWatch {
    struct Watch {
        uint64 lastAt; // last time the expected event was seen (or the arming time)
        uint64 maxGap; // seconds of silence tolerated
        bool armed;
    }

    error ZeroGap();

    function init(Watch storage w, uint64 maxGap) internal {
        if (maxGap == 0) revert ZeroGap();
        w.maxGap = maxGap;
    }

    function arm(Watch storage w, uint64 nowTs) internal {
        w.armed = true;
        w.lastAt = nowTs;
    }

    function disarm(Watch storage w) internal {
        w.armed = false;
    }

    /// @notice Record a sighting. Monotonic: an older timestamp never moves `lastAt` back.
    /// @return advanced true if `lastAt` moved forward.
    function seen(Watch storage w, uint64 ts) internal returns (bool advanced) {
        if (ts > w.lastAt) {
            w.lastAt = ts;
            return true;
        }
        return false;
    }

    /// @notice First instant at which the watch counts as stale.
    function deadline(Watch storage w) internal view returns (uint64) {
        return w.lastAt + w.maxGap;
    }

    /// @notice True when armed and silent for longer than `maxGap`. A disarmed watch is never stale: callers that must
    ///         fail closed when a watch was never armed in time (Heirloom's canary at the deadline) check `armed` themselves.
    function isStale(Watch storage w, uint64 nowTs) internal view returns (bool) {
        return w.armed && nowTs > w.lastAt + w.maxGap;
    }

    /// @notice Seconds since the last sighting (0 if in the future).
    function age(Watch storage w, uint64 nowTs) internal view returns (uint64) {
        return nowTs > w.lastAt ? nowTs - w.lastAt : 0;
    }
}
